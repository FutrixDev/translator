// AI Translator Content Script Page Translation
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const { constants, settings, state } = ctx;
  const { MATH_CONTAINER_SELECTOR } = constants;
  const t = ctx.t;
  const escapeHtml = ctx.escapeHtml;
  const isExtensionContextAvailable = ctx.isExtensionContextAvailable;
  const isExtensionContextInvalidated = ctx.isExtensionContextInvalidated;
  const getEffectiveTargetLang = ctx.getEffectiveTargetLang;
  const getLangBase = ctx.getLangBase;
  const getLanguageDetectionText = ctx.getLanguageDetectionText;

// ==================== Page Translation ====================

  const MAX_BATCH_CHARS = 9000; // 每批次最大字符数（加大以减少请求）
  const MAX_BATCH_ITEMS = 40;   // 每批次最大段落数（加大以减少请求）
  const MAX_BATCH_TOKENS = 3200; // 估算 token 上限（输入侧保守值）
  const MAX_BLOCK_CHARS = 4000; // 单个块最大字符数；超过则按标点分块（见 splitTextIntoChunks），避免正文被丢弃或被模型截断
  const CONCURRENCY = 12;       // 并发数
  const DELIMITER = '⟪⟫⟪⟫⟪⟫';   // 分隔符（使用 Unicode 数学括号，极不可能出现在正文中）

  // 内联格式标记：整页翻译提取文本时，把 <a>/<strong>/<em> 等内联格式元素编码成
  // 成对的 <a1>…</a1> 标记随正文一起送翻，译文再按标记克隆原元素重建（见
  // buildTranslationContent），从而保留超链接（href）和内联样式（class/style）。
  //
  // **两个引擎都生成标记。** 这里曾经只在 AI 引擎下生成，理由是“内置 NMT 没有
  // 原样保留标记的承诺”——那是假设，实测不成立。拿 Chrome 内置 Translator 跑
  // en→zh-Hans / zh-Hant / ja，每句连翻三遍结果一致：
  //
  //   12 句 × 3 语言里，标记原样往返的 8 成以上；zh-Hans 的两处缺陷是
  //   `<a1>` 被大写成 `<A1>`（闭标记仍是小写），一处是 `</strong2>` 整个丢失。
  //
  // 所以标记是能用的，只是要求解析端宽容：markerRe 大小写不敏感、容空白（见
  // buildTranslationContent），丢了闭标记就在结尾自动闭合。默认引擎正是内置
  // NMT，之前的开关等于让绝大多数用户的译文一个超链接都留不下。
  //
  // 大小写不敏感同样适用于这条正则：译文里的标记可能是 <A1>。
  const MARKUP_MARKER_RE = /<\/?[a-z]+\d+>/gi;
  // 直属文本节点的锚点类名，见 wrapDirectTextRuns
  const TEXT_RUN_CLASS = 'ai-translator-text-run';

  // 由本块**真正生成过**的标签名与编号拼出的正则，用来清掉解析后仍留在译文里的
  // 标记残骸（模型把 <a1>/<strong2> 串成了 <strong1> 这种，配不上任何一对，
  // 重建时只能原样跳过）。
  // 只认自己用过的标签名和编号，是为了不动页面正文：讲 HTML 的页面正文里就写着
  // <b2> 这类字样，我们没生成过 b 标记时它一个字都不该被删。
  function markupDebrisRe(markupElements) {
    if (!markupElements || markupElements.length === 0) return null;
    const tags = [...new Set(markupElements.map((mk) => mk.tag))].join('|');
    const nums = [...new Set(markupElements.map((mk) => String(mk.index)))].join('|');
    return new RegExp(`<\\s*/?\\s*(?:${tags})\\s*(?:${nums})\\s*>`, 'gi');
  }
  const MARKUP_TAGS = new Set([
    'A', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'SUP', 'SUB', 'MARK', 'SMALL',
    'ABBR', 'DEL', 'INS', 'Q', 'CITE', 'DFN', 'CODE', 'KBD', 'SAMP', 'VAR'
  ]);

  // looksLikeCode/isMainlyUrl/长度阈值这类“对正文的判断”都要先剥掉占位符和
  // 内联标记再做，否则 <a1></a1> 里的尖括号会把带链接的段落误判成代码。
  function stripPlaceholders(text) {
    if (!text) return '';
    return text.replace(/\{\{\d+\}\}/g, '').replace(MARKUP_MARKER_RE, '');
  }

  // 本轮收集里，受管容器内有多少块连生成内容都承不住而被放弃。翻译流程用它来
  // 区分“页面已经翻完了”和“正文没能翻”，两句提示的含义完全不同。
  let managedSkipCount = 0;

  async function translatePage() {
    if (!isExtensionContextAvailable()) {
      showPageTranslationProgress();
      showTranslationError(t('extensionContextInvalidated'));
      return;
    }
    // 如果之前的译文被“隐藏译文”开关隐藏了，再次点击“翻译整页”应先把它们重新显示出来。
    // 否则整页已翻译、没有新块可译时会走 length === 0 分支直接返回，
    // 译文仍处于隐藏状态，用户会觉得“再次翻译没有任何反应”。
    revealHiddenTranslations();
    if (state.isTranslatingPage) {
      console.log('AI Translator: Already translating page');
      // 如果进度条被关闭了，重新显示它并恢复进度
      let existingProgress = document.getElementById('ai-translator-progress');
      if (!existingProgress) {
        showPageTranslationProgress();
        existingProgress = document.getElementById('ai-translator-progress');
        // 恢复当前进度
        if (state.translationProgress.total > 0) {
          updatePageTranslationProgress(state.translationProgress.current, state.translationProgress.total);
        }
      }
      // 闪烁提示正在翻译中
      showTranslatingHint(existingProgress);
      return;
    }

    state.isTranslatingPage = true;
    state.translationProgress = { current: 0, total: 0 };
    showPageTranslationProgress();

    try {
      // 收集需要翻译的元素（以块级元素为单位）
      let translatableBlocks = collectTranslatableBlocks(document.body);
      translatableBlocks = await filterBlocksByLanguage(translatableBlocks);
      
      const managedSkipped = managedSkipCount;

      if (translatableBlocks.length === 0) {
        // 一块也收不到有两种完全不同的原因，不能都报“页面已翻译”：真的翻完了，
        // 还是正文整个落在受管容器里、且那里的块连生成内容都承不住。后者报
        // “已翻译”是彻头彻尾的误导。
        if (!managedSkipped) state.pageHasBeenTranslated = true;
        showPageNotice(managedSkipped ? t('pageContentNotTranslatable') : t('pageAlreadyTranslated'));
        state.isTranslatingPage = false;
        return;
      }

      if (managedSkipped) {
        // 收到了大部分块，但受管容器里有几块画不出来（有公式、站点自己用了
        // ::after、块是 flex/grid 容器）。译文会照常出现，只是缺那几块，所以
        // 不打断流程，只留一条线索。
        console.info(`AI Translator: ${managedSkipped} block(s) inside a managed editor root cannot carry generated content`);
      }

      // 优先处理首屏相关内容
      const { priorityBlocks, deferredBlocks } = splitBlocksByViewport(translatableBlocks);

      // 按 token/字符数/段落数智能分批
      const priorityBatches = createSmartBatches(priorityBlocks);
      const deferredBatches = createSmartBatches(deferredBlocks);
      // 软优先：首屏批次排在前面，但不阻塞后续批次启动
      const batches = priorityBatches.concat(deferredBatches);
      
      console.log(`AI Translator: ${translatableBlocks.length} blocks, ${batches.length} batches, concurrency: ${CONCURRENCY}`);

      state.translationProgress.total = translatableBlocks.length;

      // batchError 一旦置上，剩余批次全部跳过。原来是“一批失败就整页放弃”，
      // 在一批 40 段的年代这没问题：那种粒度下出错基本等于接口不可用。
      // 内置引擎改成一块一批之后，同一个判断会让某一段的偶发失败带走后面几百块
      // （并发 12，表现就是零散翻了十几块然后整片空白）。所以改成累计阈值：
      // 攒够这么多次失败才认定是整体故障。真故障时每块都失败，照样瞬间就停，
      // 不会白白多打几百次请求。
      const MAX_BATCH_FAILURES = 3;
      let batchError = null;
      let batchFailures = 0;
      let firstFailureMessage = null;

      const noteBatchFailure = (message) => {
        if (!firstFailureMessage) firstFailureMessage = message || t('translationFailed');
        batchFailures += 1;
        if (batchFailures >= MAX_BATCH_FAILURES) batchError = firstFailureMessage;
      };

      // 处理超大块：按标点分块 → 分别翻译（必要时拆成多次请求）→ 按序拼回一个整体插入。
      // 这样正文（尤其是位于 <li> 直属文本节点、用 <br><br> 分段的“超大列表项”）不会被丢弃，
      // 也不会因一次性塞给模型过长而被截断。
      const processOversizedBlock = async (block) => {
        const chunks = splitTextIntoChunks(block.text, MAX_BLOCK_CHARS);
        if (chunks.length === 0) return;
        const translations = new Array(chunks.length);

        // 把分块再按批量上限打包，避免单次请求超过 MAX_BATCH_CHARS
        const subBatches = [];
        let sub = [];
        let subChars = 0;
        for (let i = 0; i < chunks.length; i++) {
          if (sub.length > 0 && subChars + chunks[i].length > MAX_BATCH_CHARS) {
            subBatches.push(sub);
            sub = [];
            subChars = 0;
          }
          sub.push({ index: i, text: chunks[i] });
          subChars += chunks[i].length;
        }
        if (sub.length > 0) subBatches.push(sub);

        for (const sb of subBatches) {
          if (batchError) return;
          try {
            const response = await ctx.requestTranslation({
              type: 'TRANSLATE_BATCH_FAST',
              texts: sb.map(x => x.text),
              targetLang: getEffectiveTargetLang(),
              delimiter: DELIMITER,
              allowDownload: true
            });

            if (response.error) {
              noteBatchFailure(response.error);
              return;
            }

            // 分隔符切分数量不匹配：放弃本块（保持原文），不呈现错位/残缺译文。
            // 这属于单块问题，不设 batchError、不影响整页其它块。
            if (!response.translations || response.translations.length !== sb.length) {
              return;
            }
            sb.forEach((x, k) => {
              translations[x.index] = response.translations[k];
            });
          } catch (error) {
            console.error('AI Translator: Oversized block translation failed', error);
            if (isExtensionContextInvalidated(error)) {
              // 扩展上下文没了，后面每一块都必然失败，没有继续的意义。
              batchError = t('extensionContextInvalidated');
            } else {
              noteBatchFailure(error.message);
            }
            return;
          }
        }

        // 任一分块缺译（未定义或空）则放弃插入，避免呈现残缺译文
        if (translations.some(x => !x)) return;

        const combined = translations.join('');
        if (!combined.trim()) return;
        if (await shouldSkipTranslation(block, combined)) return;
        insertTranslationBlock(block, combined);
      };

      // 使用 Promise 池进行并发控制
      const processBatch = async (batch) => {
        // Skip if we already have an error
        if (batchError) return;
        if (!isExtensionContextAvailable()) {
          batchError = t('extensionContextInvalidated');
          return;
        }

        // 超大块：单独成批，走分块翻译流程
        if (batch.length === 1 && batch[0].oversized) {
          await processOversizedBlock(batch[0]);
          state.translationProgress.current += batch.length;
          updatePageTranslationProgress(state.translationProgress.current, state.translationProgress.total);
          return;
        }

        const texts = batch.map(item => item.text);

        try {
          // 整页翻译是用户点出来的，带着 user activation，是唯一适合触发
          // 语言包首次下载的路径（下载进度直接显示在下方进度条上）。
          const response = await ctx.requestTranslation({
            type: 'TRANSLATE_BATCH_FAST',
            texts: texts,
            targetLang: getEffectiveTargetLang(),
            delimiter: DELIMITER,
            allowDownload: true
          });

          // Check for error in response
          if (response.error) {
            noteBatchFailure(response.error);
          } else {
            // translations 缺失/非数组的畸形响应也交给守卫：按“数量不一致”处理，
            // 走逐块回退，而不是无声丢掉整批。
            await applyFastBatchTranslations(batch, response.translations, {
              onFailure: noteBatchFailure,
              isAborted: () => !!batchError
            });
          }
        } catch (error) {
          console.error('AI Translator: Batch translation failed', error);
          if (isExtensionContextInvalidated(error)) {
            batchError = t('extensionContextInvalidated');
          } else {
            noteBatchFailure(error.message);
          }
        }

        state.translationProgress.current += batch.length;
        updatePageTranslationProgress(state.translationProgress.current, state.translationProgress.total);
      };

      // 并发执行所有批次，首屏批次在队列前优先开始
      if (batches.length > 0) {
        await runWithConcurrency(batches, processBatch, CONCURRENCY);
      }

      // Check if there was an error during translation
      if (batchError) {
        showTranslationError(batchError);
      } else {
        // 标记页面已翻译
        state.pageHasBeenTranslated = true;
        hidePageTranslationProgress();
      }
    } catch (error) {
      console.error('AI Translator: Page translation failed', error);
      showTranslationError(error.message || t('translationFailed'));
    } finally {
      state.isTranslatingPage = false;
      state.translationProgress = { current: 0, total: 0 };
    }
  }

  // 重新显示被“隐藏译文”开关隐藏的所有译文块，并同步开关状态，
  // 使浮球菜单下次显示为“隐藏译文”。
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

  function estimateTokens(text) {
    if (!text) return 0;
    const cjkMatches = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu);
    const cjkCount = cjkMatches ? cjkMatches.length : 0;
    const nonCjkCount = Math.max(0, text.length - cjkCount);
    return Math.ceil(cjkCount * 1.1 + nonCjkCount / 4);
  }

  // 按视口优先拆分：首屏和附近内容优先处理
  function splitBlocksByViewport(blocks) {
    const priorityBlocks = [];
    const deferredBlocks = [];
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 800;
    const margin = viewportHeight * 1.2;

    blocks.forEach(block => {
      const el = block.element;
      if (!el || !el.getBoundingClientRect) {
        deferredBlocks.push(block);
        return;
      }

      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        deferredBlocks.push(block);
        return;
      }

      const inPriorityRange = rect.bottom >= -margin && rect.top <= viewportHeight + margin;
      if (inPriorityRange) {
        priorityBlocks.push(block);
      } else {
        deferredBlocks.push(block);
      }
    });

    return { priorityBlocks, deferredBlocks };
  }

  // 若 pos 落在数学占位符 {{数字}} 内部，回退到该占位符起点，避免把占位符切成两半
  function avoidPlaceholderSplit(text, start, pos) {
    if (pos <= start || pos >= text.length) return pos;
    const open = text.lastIndexOf('{{', pos - 1);
    if (open < start) return pos;             // pos 之前没有未闭合的 {{
    const close = text.indexOf('}}', open);
    if (close === -1) return pos;             // 不是有效占位符
    if (close + 2 <= pos) return pos;         // 占位符已在 pos 之前闭合，安全
    return open > start ? open : pos;         // pos 位于占位符内部 → 回退到 {{ 之前
  }

  // 将超长文本按标点切分为不超过 maxLen 的块，尽量在句末/子句/空白处断开，
  // 且不切断数学占位符 {{n}}。每块的结尾标点/空白予以保留，拼接时可无缝还原。
  function splitTextIntoChunks(text, maxLen) {
    if (!text || text.length <= maxLen) return text ? [text] : [];

    const sentenceEnd = /[.．。!！?？…;；\n]/;   // 句末标点（中英）
    const clauseEnd = /[,，、:：)）]/;            // 子句标点
    const chunks = [];
    const len = text.length;
    let start = 0;

    while (start < len) {
      if (len - start <= maxLen) {
        chunks.push(text.slice(start));
        break;
      }

      const hardEnd = avoidPlaceholderSplit(text, start, start + maxLen);
      let breakAt = -1;

      // 优先句末标点，其次子句标点，再次空白，最后硬切
      for (let i = hardEnd - 1; i > start; i--) {
        if (sentenceEnd.test(text[i])) { breakAt = i + 1; break; }
      }
      if (breakAt <= start) {
        for (let i = hardEnd - 1; i > start; i--) {
          if (clauseEnd.test(text[i])) { breakAt = i + 1; break; }
        }
      }
      if (breakAt <= start) {
        for (let i = hardEnd - 1; i > start; i--) {
          if (/\s/.test(text[i])) { breakAt = i + 1; break; }
        }
      }
      if (breakAt <= start) breakAt = hardEnd;

      breakAt = avoidPlaceholderSplit(text, start, breakAt);
      if (breakAt <= start) breakAt = Math.min(start + maxLen, len);

      chunks.push(text.slice(start, breakAt));
      start = breakAt;
    }

    return chunks.filter(c => c.length > 0);
  }

  function usingBuiltinEngine() {
    return !!(ctx.builtinTranslator && ctx.builtinTranslator.isActive());
  }

  // 智能分批：根据 token/字符数/段落数限制
  function createSmartBatches(blocks) {
    // 内置引擎按段单独调用，攒批只有坏处：攒批是为了摊薄一次 HTTPS 往返 + 一次
    // LLM 生成的固定开销，而内置引擎是端上调用、没有这份开销。拆成一块一批之后，
    // 每块译完就能立刻插进页面，用户不用等一整批 40 段都回来才看到内容。
    if (usingBuiltinEngine()) {
      return blocks.map((block) => [block]);
    }

    const batches = [];
    let currentBatch = [];
    let currentChars = 0;
    let currentTokens = 0;
    const itemTokenOverhead = 6;

    const flush = () => {
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
        currentBatch = [];
        currentChars = 0;
        currentTokens = 0;
      }
    };

    for (const block of blocks) {
      // 超大块单独成批，交由 processBatch 内的分块逻辑（splitTextIntoChunks）处理
      if (block.oversized) {
        flush();
        batches.push([block]);
        continue;
      }

      const textLen = block.text.length;
      const tokenEstimate = estimateTokens(block.text) + itemTokenOverhead;

      // 如果当前批次加入这个 block 后会超限，先保存当前批次
      if (currentBatch.length > 0 &&
          (currentTokens + tokenEstimate > MAX_BATCH_TOKENS ||
           currentChars + textLen > MAX_BATCH_CHARS ||
           currentBatch.length >= MAX_BATCH_ITEMS)) {
        flush();
      }

      currentBatch.push(block);
      currentChars += textLen;
      currentTokens += tokenEstimate;
    }

    // 保存最后一个批次
    flush();

    return batches;
  }

  // 并发控制函数
  async function runWithConcurrency(items, processor, concurrency) {
    const results = [];
    let index = 0;
    
    async function runNext() {
      const currentIndex = index++;
      if (currentIndex >= items.length) return;
      
      await processor(items[currentIndex]);
      results[currentIndex] = true;
      
      // 继续处理下一个
      await runNext();
    }
    
    // 启动 concurrency 个并发任务
    const workers = [];
    for (let i = 0; i < Math.min(concurrency, items.length); i++) {
      workers.push(runNext());
    }
    
    await Promise.all(workers);
    return results;
  }

  // 收集可翻译的块级元素
  function collectTranslatableBlocks(root) {
    managedSkipCount = 0;
    const blocks = [];
    const blockTags = ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TD', 'TH', 'FIGCAPTION', 'BLOCKQUOTE', 'DT', 'DD'];
    // 内联可翻译元素 - 这些元素即使不是块级也应单独翻译
    const inlineTags = ['A', 'SPAN', 'LABEL', 'BUTTON'];
    const skipTags = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'TEXTAREA', 'INPUT', 'SELECT', 'CODE', 'PRE', 'SVG', 'CANVAS', 'KBD', 'SAMP', 'VAR'];
    // 容器元素 - 这些元素不应作为整体翻译，应递归处理子元素
    // 表格标签作为容器递归下探到单元格（TD/TH 在 blockTags 中）：很多站点（如 Hacker News）
    // 用表格做整页布局，若把 TABLE/TR 当作 skipTags 会跳过全部正文，导致“0 个可译块 → 误报页面已翻译”。
    const containerTags = ['NAV', 'UL', 'OL', 'DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'HEADER', 'FOOTER', 'MAIN', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR'];
    // 用于检测代码/脚本内容的模式
    const codePatterns = [
      /^[\s\S]*<script[\s>]/i,       // 包含 <script 标签
      /^[\s\S]*<\/script>/i,         // 包含 </script> 标签
      /^[\s\S]*<noscript[\s>]/i,     // 包含 <noscript 标签
      /function\s*\([^)]*\)\s*\{/,   // JavaScript 函数定义
      /var\s+\w+\s*=/,               // var 声明
      /const\s+\w+\s*=/,             // const 声明
      /let\s+\w+\s*=/,               // let 声明
      /document\.(getElementById|querySelector|createElement)/, // DOM 操作
      /^\s*(import|export)\s+/m,     // ES6 模块
      /^\s*def\s+\w+\s*\(/m,         // Python 函数
      /^\s*class\s+\w+[\s:(]/m,      // 类定义
      /^\s*@\w+\s*$/m,               // 装饰器
      /^\s*#\s*(include|define|ifdef)/m, // C/C++ 预处理
      /\{\s*"[^"]+"\s*:\s*/,         // JSON 对象
      /^\s*```/m,                     // Markdown 代码块标记
      /self\.\w+\s*=/,               // Python self
      /super\(\)/,                   // super 调用
      /nn\.Module/,                  // PyTorch
      /torch\.\w+/,                  // PyTorch
      /np\.\w+/,                     // NumPy
    ];

    // 代码块容器的 class 检测。全部按【完整 class token】匹配，绝不用 [class*=] 子串匹配：
    //
    // - highlight / highlighter 及其 - 连接的变体（highlight、highlight-source-js、
    //   highlighter-rouge、js-highlight）。营销站常用 highlights/highlighted 命名普通
    //   内容区块——如 retellai.com 用 <section class="c-home-highlights-accordion-2"> 包住
    //   整篇博客正文，子串命中会把整篇正文当成代码块跳过，整页翻译对正文完全不生效。
    //
    // - Prism 的 language-<lang>。这条尤其危险：原来写成 [class*="language-"]，而
    //   Wikipedia 的 Vector 2022 皮肤在 <html> 上挂了 vector-feature-language-in-header-enabled，
    //   子串命中的是 <html>，于是 processElement(document.body) 第一步就 return，
    //   整页一个块都收不到 → 误报“页面已翻译”，全文翻译对所有维基页面彻底失效。
    //   只按 token 前缀匹配仍然不够：language-switcher / language-list / language-item
    //   是多语言站导航的常见命名。所以还要求这个祖先真的装着代码（自身是 <pre>/<code>
    //   或子孙里有），语言切换器不可能满足。
    //
    // - LaTeXML 的 ltx_listing / ltx_lstlisting / ltx_listingline / ltx_verbatim
    //   （arXiv HTML 版与 ar5iv 论文的代码清单）。这条必须单列，上面两条都够不着它：
    //   LaTeXML 把语种写成 ltx_lst_language_Python，是【下划线】，language- 匹配不到；
    //   而清单里根本没有 <pre>/<code>——结构是
    //   <div class="ltx_listing"><div class="ltx_listingline"><span class="ltx_text …">，
    //   于是每个 <span> 都作为内联可译元素被单独送去翻译（实测泄漏 qa / dspy / Predict /
    //   "question->answer" / # Out: Prediction(...)）。looksLikeCode() 也接不住：
    //   拆到单个 span 之后碎片里一个特殊字符都没有。
    const highlightClassTokenRe = /(^|-)highlight(er)?(-|$)/;
    const CODE_CONTAINER_CLASSES = new Set([
      'codehilite', 'sourceCode', 'code-block',
      'ltx_listing', 'ltx_lstlisting', 'ltx_listingline', 'ltx_verbatim',
    ]);
    function holdsCode(el) {
      const tagName = el.tagName;
      return tagName === 'PRE' || tagName === 'CODE' || !!el.querySelector('pre, code');
    }
    function isInsideCodeContainer(element) {
      for (let el = element; el; el = el.parentElement) {
        const classList = el.classList;
        if (!classList) continue;
        for (const cls of classList) {
          if (highlightClassTokenRe.test(cls)) return true;
          if (CODE_CONTAINER_CLASSES.has(cls)) return true;
          if (cls.startsWith('language-') && holdsCode(el)) return true;
        }
      }
      return false;
    }

    // 检查文本是否看起来像代码
    function looksLikeCode(text) {
      // 如果包含大量特殊字符，可能是代码
      const specialCharRatio = (text.match(/[{}()\[\];=<>]/g) || []).length / text.length;
      if (specialCharRatio > 0.1) return true;

      // 检查代码模式
      for (const pattern of codePatterns) {
        if (pattern.test(text)) return true;
      }

      return false;
    }

    // 检查文本是否主要是URL（不需要翻译）
    function isMainlyUrl(text) {
      // URL正则模式
      const urlPattern = /https?:\/\/[^\s]+/gi;
      const urls = text.match(urlPattern) || [];
      if (urls.length === 0) return false;

      // 计算URL占文本的比例
      const urlLength = urls.reduce((sum, url) => sum + url.length, 0);
      const textWithoutUrls = text.replace(urlPattern, '').trim();

      // 如果移除URL后剩余文本很短（少于10个字符或只有标签如 "DOI:", "URL:" 等）
      // 则认为主要是URL
      if (textWithoutUrls.length < 10) return true;

      // 如果URL占总文本长度的70%以上，认为主要是URL
      if (urlLength / text.length > 0.7) return true;

      return false;
    }

    // 检查文本是否只由数字与常见数值符号组成（数据表单元格常见，如 0.83、94.2%、±0.02、1,234）。
    // 这类单元格翻译无意义，还会给结果表添噪，直接跳过。要求至少含一个数字，
    // 以免误伤 "N/A"、"Method" 等含字母的表头/文本单元格。
    function isNumericOrSymbolOnly(text) {
      const t = (text || '').trim();
      if (!t) return false;
      if (!/\d/.test(t)) return false;
      return /^[\d\s.,%±+\-*/()<>=:~×·°∓‰$€£¥–—]+$/.test(t);
    }

    // 检查元素是否有可翻译的子元素（用于判断是否应该递归而非整体翻译）
    function hasTranslatableChildren(element) {
      for (const child of element.children) {
        // 跳过数学公式元素 - 数学公式应该作为整体保留，不应该导致父元素被拆分
        if (isMathElement(child)) {
          continue;
        }
        // 跳过图标元素
        if (isIconElement(child)) {
          continue;
        }
        const childTag = child.tagName;
        // 如果子元素是块级或内联可翻译元素，且有文本内容
        if ((blockTags.includes(childTag) || inlineTags.includes(childTag)) &&
            child.textContent.trim().length >= 2) {
          return true;
        }
        // 递归检查
        if (hasTranslatableChildren(child)) {
          return true;
        }
      }
      return false;
    }

    // 把元素的【直属文本节点】按连续段裹进 <span>，给它们一个能收进 blocks、
    // 之后能挂译文的锚点——文本节点自己两样都做不到。
    // 只裹真要翻的那几段（太短、像代码、就是个 URL、纯数字的都不裹），页面 DOM
    // 就一个多余节点都不会多出来；<br>/<span> 这些元素天然把文本分段，分开裹，
    // 原来的换行结构就还在。
    function wrapDirectTextRuns(element) {
      const runs = [];
      let current = null;
      for (const node of element.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          if (!current) {
            current = [];
            runs.push(current);
          }
          current.push(node);
          continue;
        }
        current = null;
      }
      for (const run of runs) {
        const text = run.map((node) => node.textContent).join('').trim();
        if (text.length < 2) continue;
        if (looksLikeCode(text) || isMainlyUrl(text) || isNumericOrSymbolOnly(text)) continue;
        const wrap = document.createElement('span');
        wrap.className = TEXT_RUN_CLASS;
        element.insertBefore(wrap, run[0]);
        for (const node of run) wrap.appendChild(node);
      }
    }

    // 检查元素是否有多个可翻译的直接子元素（用于判断是否应该递归而非整体翻译）
    // 这对于导航菜单等结构很重要，避免将整个菜单作为一个块翻译
    function hasMultipleTranslatableDirectChildren(element) {
      let count = 0;
      for (const child of element.children) {
        const childTag = child.tagName;
        // 如果子元素是块级或内联可翻译元素，且有文本内容
        if ((blockTags.includes(childTag) || inlineTags.includes(childTag)) &&
            child.textContent.trim().length >= 2) {
          count++;
          if (count >= 2) return true;
        }
      }
      return false;
    }

    // 获取元素的直接文本内容（不包括子元素的文本）
    function getDirectText(element) {
      let text = '';
      for (const child of element.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          const content = child.textContent.trim();
          if (content) {
            text += content + ' ';
          }
        }
      }
      return text.trim();
    }

    function processElement(element) {
      if (!element || element.nodeType !== Node.ELEMENT_NODE) return;

      const tagName = element.tagName;

      // 跳过不需要翻译的元素
      if (skipTags.includes(tagName)) return;
      if (element.isContentEditable) return;
      // 受管容器（只读的 Lexical / ProseMirror 等）会把插进去的译文节点撤销掉，
      // 那里的译文只能画成原文块自己的 ::after（见 content-managed-translation.js）。
      // 生成内容承不住的块——有公式、站点自己占用了 ::after、块本身是 flex/grid
      // 容器——翻出来也显示不了，这里就不收：省一次 API 调用的钱。
      if (ctx.isInsideManagedDomRoot && ctx.isInsideManagedDomRoot(element)) {
        const hasMath = !!(MATH_CONTAINER_SELECTOR && element.querySelector(MATH_CONTAINER_SELECTOR));
        if (!(ctx.canRenderManagedTranslation && ctx.canRenderManagedTranslation(element, { hasMath }))) {
          managedSkipCount++;
          return;
        }
      }
      if (element.closest('.ai-translator-popup, .ai-translator-translated, .ai-translator-inline-source, .ai-translator-inline-block, #ai-translator-float-ball, #ai-translator-float-menu, #ai-translator-progress, #ai-translator-selection-btn')) return;
      if (element.classList.contains('ai-translator-translated')) return;
      if (element.classList.contains('ai-translator-inline-source')) return;

      // 跳过被 skipTags 包含的元素
      if (element.closest(skipTags.map(t => t.toLowerCase()).join(','))) return;

      // 跳过代码块容器（codehilite / sourceCode / highlight 变体 / Prism language-*，
      // 统一在 isInsideCodeContainer 里按完整 class token 匹配）
      if (isInsideCodeContainer(element)) return;

      // 跳过数学公式内部的所有元素 - 数学公式应该整体保留，不单独翻译内部元素
      if (element.closest(MATH_CONTAINER_SELECTOR)) return;

      // 跳过数学公式的隐藏辅助元素（只跳过重复的隐藏版本）
      if (element.classList.contains('MJX_Assistive_MathML') ||
          element.classList.contains('katex-mathml') ||
          element.classList.contains('sr-only') ||
          element.classList.contains('visually-hidden') ||
          element.classList.contains('MathJax_Preview')) return;

      // 跳过 Web Components 的覆盖层 slot 元素
      // 这些元素通常是 absolute 定位覆盖整个区域用于点击跳转
      // 例如 Reddit 的 slot="full-post-link" 元素
      if (element.hasAttribute('slot')) {
        const classList = element.classList;
        // 检测是否是覆盖层元素（absolute 定位 + inset-0 或类似的全覆盖类）
        if ((classList.contains('absolute') || classList.contains('fixed')) &&
            (classList.contains('inset-0') ||
             (classList.contains('top-0') && classList.contains('left-0') &&
              classList.contains('right-0') && classList.contains('bottom-0')))) {
          return; // 跳过覆盖层元素
        }
      }

      // 检查是否有直接文本内容
      const directText = getDirectText(element);
      const hasDirectText = directText.length >= 2;

      // 对于任何有可翻译子元素的元素，检查是否应该递归处理而非整体翻译
      // 这确保导航菜单等嵌套结构的每个项被单独翻译
      // 注意：只有当子元素是【块级元素】时才递归，内联元素（如 <a>、<span>）应该包含在整体翻译中
      if (hasTranslatableChildren(element)) {
        let shouldRecurse = false;
        for (const child of element.children) {
          // 跳过数学公式和图标
          if (isMathElement(child) || isIconElement(child)) {
            continue;
          }
          const childTag = child.tagName;
          // 只有当直接子元素是【块级】可翻译元素时才递归
          // 内联元素（如 a, span）应该作为父元素内容的一部分整体翻译
          if (blockTags.includes(childTag) && child.textContent.trim().length >= 2) {
            shouldRecurse = true;
            break;
          }
          // 情况2：直接子元素是容器元素（如 div, ul）且包含可翻译内容
          if (containerTags.includes(childTag) && hasTranslatableChildren(child)) {
            shouldRecurse = true;
            break;
          }
        }

        // 如果满足递归条件，递归处理子元素而不是整体翻译
        if (shouldRecurse) {
          // 递归只走 element.children，而【直属文本节点】不在里面。不先把它们裹起来，
          // 一个块级子元素就足以让本元素自己的正文整段消失——
          // alignment.anthropic.com 的对话框正是这个形状：
          //   <div class="code-box"><span>Human:</span> Write a one-stanza poem…<p>…</p></div>
          // 里面的 <p> 让这里递归，于是 "Write a one-stanza poem…" 一次都没被送去
          // 翻译，页面上只剩 <span>Human:</span> 的译文孤零零挂在原文右边。
          // 同一个坑在超长块那条路上已经栽过一次，见 MAX_BLOCK_CHARS 附近的注释。
          wrapDirectTextRuns(element);
          for (const child of element.children) {
            processElement(child);
          }
          return;
        }
      }

      // 对于内联元素（如链接、按钮），如果有文本内容，单独翻译
      if (inlineTags.includes(tagName)) {
        const { text, mathElements, markupElements } = getTextWithMathPlaceholders(element, { preserveMarkup: true });
        // 长度阈值按剥掉占位符/内联标记后的正文算，标记本身不该把短链接顶出上限
        const plainText = stripPlaceholders(text).trim();
        if (text && plainText.length >= 2 && plainText.length <= 500) {
          // 跳过看起来像代码或主要是URL的文本
          // 这里要 trim：只含公式的元素排除占位符后会剩下空白（如 "{{1}} {{2}}"），
          // 不 trim 会被当成有正文，进而把纯公式送去翻译。
          const textWithoutMath = plainText;
          if (textWithoutMath && !looksLikeCode(textWithoutMath) && !isMainlyUrl(textWithoutMath)) {
            blocks.push({
              element: element,
              text: text,
              tagName: tagName,
              mathElements: mathElements,
              markupElements: markupElements
            });
            return;
          }
        }
      }

      // 对于块级元素
      if (blockTags.includes(tagName) || hasDirectText) {
        let { text, mathElements, markupElements } = getTextWithMathPlaceholders(element, { preserveMarkup: true });
        if (text && text.length >= 2) {
          // 跳过看起来像代码或主要是URL的文本（排除数学占位符和内联标记后判断）
          const textWithoutMath = stripPlaceholders(text).trim();

          // 排除公式占位符后没有任何正文：整个块就是一条公式，跳过。
          // 典型是 arXiv/LaTeXML 的行间公式——公式包在 <table class="ltx_equation"> 里，
          // 遍历下探到 <td class="ltx_eqn_cell"> 时 text 只有 "{{1}}"。
          // 若不跳过，"{{1}}" 会被送去翻译，模型原样返回后再按占位符 clone 回原 <math>，
          // 结果是同一条公式在原文下方又渲染一遍（公式出现两遍）。
          // 这里 return 而不递归：块内只有公式，子元素会被 MATH_CONTAINER_SELECTOR 拦下，递归没有意义。
          if (!textWithoutMath) return;

          // 数据表单元格若只是数字/符号（如 0.83、94.2%），跳过：翻译无意义且会给结果表加噪
          if ((tagName === 'TD' || tagName === 'TH') && isNumericOrSymbolOnly(textWithoutMath)) {
            return;
          }
          if (textWithoutMath && (looksLikeCode(textWithoutMath) || isMainlyUrl(textWithoutMath))) {
            // 递归处理子元素，可能有非代码/非URL的部分
            for (const child of element.children) {
              processElement(child);
            }
            return;
          }

          // 超长块（如把整段正文塞进一个 <li>、用 <br><br> 分段的“超大列表项”）：
          // 标记 oversized，稍后按标点分块翻译。
          // 不能像以前那样在超限时回退去递归子元素——正文位于本元素的【直属文本节点】里，
          // 递归只遍历子【元素】会把正文整段丢弃，只剩标题/链接被翻译。
          // 超长块回退成纯文本提取：splitTextIntoChunks 只认得 {{n}} 占位符，
          // 会把成对的内联标记从中间切开、拆进不同请求，重建必然错乱。
          if (text.length > MAX_BLOCK_CHARS && markupElements && markupElements.length > 0) {
            const plain = getTextWithMathPlaceholders(element);
            text = plain.text;
            mathElements = plain.mathElements;
            markupElements = [];
          }
          const block = {
            element: element,
            text: text,
            tagName: tagName,
            mathElements: mathElements, // 保存公式信息
            markupElements: markupElements
          };
          if (text.length > MAX_BLOCK_CHARS) {
            block.oversized = true;
          }
          blocks.push(block);
          return; // 不再递归处理子元素
        }
      }

      // 递归处理子元素
      for (const child of element.children) {
        processElement(child);
      }
    }

    processElement(root);
    return blocks;
  }

  // 获取清理后的数学公式 HTML（移除辅助元素，保留视觉渲染）
  function getCleanMathHtml(node) {
    // 克隆节点以避免修改原始 DOM
    const clone = node.cloneNode(true);

    // 需要移除的辅助元素选择器
    const assistiveSelectors = [
      '.MJX_Assistive_MathML',      // MathJax 3 辅助 MathML
      '.mjx-assistive-mml',          // MathJax 3 辅助 MathML (小写)
      '.katex-mathml',               // KaTeX 辅助 MathML
      '.katex-html[aria-hidden]',    // KaTeX 隐藏的 HTML
      '.sr-only',                    // 屏幕阅读器专用
      '.visually-hidden',            // 视觉隐藏
      '.MathJax_Preview',            // MathJax 预览
      'annotation',                  // MathML annotation (文本注释)
      'annotation-xml',              // MathML annotation-xml (XML 注释，arXiv 常用)
      'semantics > mrow:not(:first-child)', // MathML semantics 中的额外内容
    ];

    // 移除所有辅助元素
    assistiveSelectors.forEach(selector => {
      try {
        clone.querySelectorAll(selector).forEach(el => el.remove());
      } catch (e) {
        // 忽略无效选择器
      }
    });

    // 移除 aria-hidden="true" 但保留可见内容的元素
    // 注意：不移除整个元素，只移除 aria-hidden 属性下的某些特定子元素

    // 确保数学公式保持内联显示
    // 使用 !important 覆盖页面 CSS（如 MathJax 默认的 display: block）
    clone.style.setProperty('display', 'inline', 'important');
    clone.style.setProperty('vertical-align', 'baseline', 'important');

    return clone.outerHTML;
  }

  // 检测元素是否是数学公式或其内部元素
  function isMathElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;

    // 检查标签名 - 顶层数学容器
    const mathContainerTags = ['MATH', 'MJX-CONTAINER', 'MJX-MATH'];
    if (mathContainerTags.includes(el.tagName)) return true;

    // 检查 MathML 子元素标签 - 这些标签只会出现在数学公式内部
    const mathMLChildTags = [
      'MI', 'MN', 'MO', 'MS', 'MTEXT', 'MSPACE',
      'MSUB', 'MSUP', 'MSUBSUP', 'MUNDER', 'MOVER', 'MUNDEROVER',
      'MFRAC', 'MROOT', 'MSQRT', 'MROW', 'MFENCED', 'MTABLE',
      'MTR', 'MTD', 'MALIGNGROUP', 'MALIGNMARK', 'MSTYLE',
      'MERROR', 'MPADDED', 'MPHANTOM', 'MGLYPH', 'MACTION',
      'SEMANTICS', 'ANNOTATION', 'ANNOTATION-XML'
    ];
    if (mathMLChildTags.includes(el.tagName)) return true;

    // 检查常见的数学公式类名
    const mathClasses = [
      'MathJax', 'MathJax_Display', 'MathJax_Preview',
      'mjx-math', 'mjx-chtml', 'mjx-container',
      'katex', 'katex-display',
      'math', 'equation'
    ];
    if (mathClasses.some(cls => el.classList?.contains(cls))) return true;

    // 检查 data 属性
    if (el.hasAttribute?.('data-mathml') || el.hasAttribute?.('data-latex')) return true;

    // 检查是否在数学容器内部（通过 closest 查找祖先）
    if (el.closest(MATH_CONTAINER_SELECTOR)) return true;

    return false;
  }

  // 检测元素是否是图标元素（图标跳过，不翻译也不保留占位符）
  function isIconElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;

    // SVG 图标
    if (el.tagName === 'SVG' || el.tagName === 'svg') return true;

    // Font Awesome 和其他图标库
    const classList = el.classList;
    if (classList) {
      const iconClasses = ['fa', 'fas', 'far', 'fal', 'fad', 'fab', 'fa-solid', 'fa-regular',
        'fa-light', 'fa-duotone', 'fa-brands', 'fa-icon', 'icon', 'iconfont', 'material-icons',
        'glyphicon', 'bi', 'feather', 'lucide'];
      if (iconClasses.some(cls => classList.contains(cls))) return true;
      // 检查是否包含 fa- 开头的类
      if (Array.from(classList).some(cls => cls.startsWith('fa-'))) return true;
    }

    return false;
  }

  // 判断一个节点是否值得作为内联格式标记保留：语义/格式标签整表收，SPAN 只收
  // 带 class 或 style 的——裸 span 没有样式可保，编码它只会给模型添乱。
  function isMarkupElement(node) {
    const tagName = node.tagName;
    if (MARKUP_TAGS.has(tagName)) return true;
    if (tagName === 'SPAN') {
      return !!(node.getAttribute('class') || node.getAttribute('style'));
    }
    return false;
  }

  // 获取元素内容，用占位符替换数学公式（图标直接跳过）
  // 返回 { text, mathElements, markupElements }：
  // - mathElements 保存 DOM 引用或 LaTeX 文本，用于后续还原
  // - markupElements 仅在 options.preserveMarkup 时非空，保存内联格式元素的引用，
  //   文本里对应成对的 <a1>…</a1> 标记（标签名小写 + 序号，序号即数组下标 + 1）
  function getTextWithMathPlaceholders(element, options) {
    const preserveMarkup = !!(options && options.preserveMarkup);
    let text = '';
    const mathElements = [];
    const markupElements = [];
    let mathIndex = 0;

    // 跳过的隐藏类名
    const hiddenClasses = [
      'MJX_Assistive_MathML', 'katex-mathml', 'sr-only',
      'visually-hidden', 'MathJax_Preview'
    ];

    function addMathPlaceholder(entry) {
      mathIndex += 1;
      const placeholder = `{{${mathIndex}}}`;
      mathElements.push({ placeholder, ...entry });
      return placeholder;
    }

    function shouldTreatAsInlineLatex(content) {
      const trimmed = content.trim();
      if (!trimmed) return false;
      if (/^\d[\d,.\s]*$/.test(trimmed)) return false;
      if (/\\/.test(trimmed)) return true;
      if (/[\^_={}|<>]/.test(trimmed)) return true;
      if (/[\p{Sm}]/u.test(trimmed)) return true;
      if (/[\p{L}]/u.test(trimmed)) return true;
      return false;
    }

    function replaceInlineLatex(content) {
      let result = content;
      result = result.replace(/\\\(([\s\S]+?)\\\)/g, (match) => {
        return addMathPlaceholder({ type: 'text', text: match });
      });
      result = result.replace(/\\\[([\s\S]+?)\\\]/g, (match) => {
        return addMathPlaceholder({ type: 'text', text: match });
      });
      result = result.replace(/\$\$([\s\S]+?)\$\$/g, (match) => {
        return addMathPlaceholder({ type: 'text', text: match });
      });
      result = result.replace(/(^|[^\\])\$([^\n$]+?)\$/g, (match, prefix, inner) => {
        if (!shouldTreatAsInlineLatex(inner)) {
          return match;
        }
        const placeholder = addMathPlaceholder({ type: 'text', text: `$${inner}$` });
        return prefix + placeholder;
      });
      return result;
    }

    function processNode(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        let content = node.textContent;
        if (content) {
          // 过滤掉 CSS 样式文本（如 .fa-secondary{opacity:.4}）
          content = content.replace(/\.[\w-]+\s*\{[^}]*\}/g, '');
          // 过滤掉 CSS 选择器残留
          content = content.replace(/\.fa-[\w-]+/g, '');
          // 保护纯文本中的 LaTeX 表达式
          content = replaceInlineLatex(content);
          // 将换行符和多余空白规范化为单个空格
          // HTML 源码中的换行符仅用于可读性，不应影响翻译格式
          content = content.replace(/\s+/g, ' ');
          if (content.trim()) {
            text += content;
          }
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        // 跳过 script 和 style 标签
        if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') return;

        // 跳过隐藏的辅助元素
        const classList = node.classList;
        if (hiddenClasses.some(cls => classList?.contains(cls))) return;

        // 跳过 display:none
        const style = window.getComputedStyle(node);
        if (style.display === 'none') return;

        // 跳过图标元素（图标是装饰，翻译不需要包含图标）
        if (isIconElement(node)) {
          return;
        }

        // 检测是否是数学公式 - 使用锚点占位符
        // 使用 {{1}}、{{2}} 格式，LLM 熟悉模板语法，会保持原样
        if (isMathElement(node)) {
          const placeholder = addMathPlaceholder({ type: 'element', element: node });
          text += placeholder;
          return;
        }

        // 内联格式元素：包上成对标记再递归。若递归后一个字都没添上（比如里面
        // 只有图标），把开标记回滚掉——空标记对既没意义又诱导模型幻觉。
        if (preserveMarkup && isMarkupElement(node)) {
          const index = markupElements.length + 1;
          const tag = node.tagName.toLowerCase();
          const open = `<${tag}${index}>`;
          const before = text.length;
          text += open;
          markupElements.push({ index, tag, element: node });
          for (const child of node.childNodes) {
            processNode(child);
          }
          if (text.length === before + open.length) {
            text = text.slice(0, before);
            markupElements.pop();
          } else {
            text += `</${tag}${index}>`;
          }
          return;
        }

        // 递归处理子节点
        for (const child of node.childNodes) {
          processNode(child);
        }
      }
    }

    for (const child of element.childNodes) {
      processNode(child);
    }

    return { text: text.trim(), mathElements, markupElements };
  }

  // 获取元素的直接文本内容（向后兼容）
  function getDirectTextContent(element) {
    const { text } = getTextWithMathPlaceholders(element);
    return text;
  }

  // 原文第一个文本相对于元素左边的偏移（跳过 icon/svg 等前置元素），用来让译文和
  // 原文的文字左对齐。
  // @param {{fromContentBox?: boolean}} options 译文插到元素【内部】时传 true：
  //   元素那圈 padding/border 译文已经继承了，再按外边框算一次就是双份缩进
  //   （.code-box 的 16px padding 会变成 32px）。
  function getTextOffsetLeft(element, options) {
    const elementRect = element.getBoundingClientRect();
    if (elementRect.width === 0) return 0;
    let originLeft = elementRect.left;
    if (options && options.fromContentBox) {
      const style = window.getComputedStyle(element);
      originLeft += (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.paddingLeft) || 0);
    }

    // 递归查找第一个文本节点的位置
    function findFirstTextRect(node) {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE && child.textContent.trim()) {
          // 使用 Range 获取文本节点的位置
          const range = document.createRange();
          range.selectNodeContents(child);
          const rects = range.getClientRects();
          if (rects.length > 0) {
            return rects[0];
          }
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          // 跳过 icon 类元素
          const tagName = child.tagName.toLowerCase();
          if (tagName === 'svg' || tagName === 'img' || tagName === 'i' ||
              tagName === 'icon' || child.classList.contains('icon') ||
              isIconElement(child)) {
            continue;
          }
          // 递归搜索子元素
          const result = findFirstTextRect(child);
          if (result) return result;
        }
      }
      return null;
    }

    const textRect = findFirstTextRect(element);
    if (textRect) {
      return Math.max(0, textRect.left - originLeft);
    }

    return 0;
  }

  // 检测父元素是否是水平布局（flex 或内联水平排列）
  function isHorizontalFlexParent(element) {
    const parent = element.parentElement;
    if (!parent) return false;

    const parentStyle = window.getComputedStyle(parent);
    const parentDisplay = parentStyle.display;
    const flexDirection = parentStyle.flexDirection;

    // 检查是否是水平 flex 布局（flex-direction: row 或 row-reverse）
    if ((parentDisplay === 'flex' || parentDisplay === 'inline-flex') &&
        (flexDirection === 'row' || flexDirection === 'row-reverse' || flexDirection === '')) {
      return true;
    }

    const inlineLayoutTags = new Set(['LI', 'A', 'SPAN', 'LABEL', 'BUTTON']);
    if (!inlineLayoutTags.has(element.tagName)) return false;

    const elementStyle = window.getComputedStyle(element);
    const elementDisplay = elementStyle.display;

    const floatValue = elementStyle.cssFloat || elementStyle.getPropertyValue('float');
    if (floatValue && floatValue !== 'none') {
      return true;
    }

    if (elementDisplay === 'inline' || elementDisplay === 'inline-block' || elementDisplay === 'inline-flex') {
      return true;
    }

    return false;
  }

  function normalizeComparableText(text) {
    if (!text) return '';
    return text
      .replace(/\{\{\d+\}\}/g, '')
      .replace(MARKUP_MARKER_RE, '')
      .replace(/\s+/g, '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim()
      .toLowerCase();
  }

  async function detectLanguage(text) {
    if (!chrome?.i18n?.detectLanguage) return null;
    return new Promise((resolve) => {
      chrome.i18n.detectLanguage(text, resolve);
    });
  }

  async function isTargetLanguageText(text) {
    const targetLang = getEffectiveTargetLang();
    const targetBase = getLangBase(targetLang);
    if (!targetBase) return false;

    const detectText = getLanguageDetectionText(text);
    if (detectText.length < 4) return false;

    const result = await detectLanguage(detectText);
    const topLang = result?.languages?.[0];
    if (!topLang) return false;

    const detectedBase = getLangBase(topLang.language);
    if (detectedBase !== targetBase) return false;

    const confidence = typeof topLang.percentage === 'number' ? topLang.percentage : 0;
    return confidence >= 85 && result.isReliable !== false;
  }

  async function shouldSkipTranslation(block, translation) {
    const normalizedOriginal = normalizeComparableText(block.text);
    const normalizedTranslation = normalizeComparableText(translation);

    // 原文除公式占位符/空白外没有任何正文时，一律不插译文（兜底不变量）。
    // normalizeComparableText 会剥掉 {{N}}，所以纯公式块在这里归一化成空串；
    // 早先写作 `normalizedOriginal && normalizedOriginal === normalizedTranslation`，
    // 空串是 falsy，同一性守卫对纯公式块从不生效，公式因而被重复渲染。
    if (!normalizedOriginal) return true;

    if (normalizedOriginal === normalizedTranslation) {
      return true;
    }

    try {
      if (!settings.autoDetect) return false;
      return await isTargetLanguageText(block.text);
    } catch (error) {
      console.warn('AI Translator: Language detection failed', error);
      return false;
    }
  }

  // 分批译文只能按位置回填，回填前数量必须一致 —— 与超大块路径（processOversizedBlock）
  // 同一条规则。模型偶尔会吞掉/多打一个分隔符（把相邻两段合并、或把一段拆成两段），
  // 数量一错开，A 块就会挂上 B 块的译文；行内标记 <a1>…</a1> 还会落进无法还原它的
  // 块里，以字面乱码呈现。数量不一致时退回逐块翻译：一块一请求，单段无从错位，
  // 最坏是某一块拿不到译文而保持原文。
  async function applyFastBatchTranslations(batch, translations, { onFailure, isAborted } = {}) {
    if (!Array.isArray(translations) || translations.length !== batch.length) {
      const returned = Array.isArray(translations) ? translations.length : 0;
      console.warn(
        `AI Translator: fast-batch returned ${returned} translations for ${batch.length} blocks; ` +
        'retrying block-by-block to avoid misaligned translations'
      );
      await translateBlocksOneByOne(batch, { onFailure, isAborted });
      return;
    }

    await Promise.all(translations.map(async (translation, i) => {
      if (!batch[i] || !translation) return;
      if (await shouldSkipTranslation(batch[i], translation)) return;
      insertTranslationBlock(batch[i], translation);
    }));
  }

  async function translateBlocksOneByOne(batch, { onFailure, isAborted } = {}) {
    for (const block of batch) {
      if (isAborted && isAborted()) return;
      try {
        const response = await ctx.requestTranslation({
          type: 'TRANSLATE_BATCH_FAST',
          texts: [block.text],
          targetLang: getEffectiveTargetLang(),
          delimiter: DELIMITER,
          allowDownload: true
        });
        if (response.error) {
          if (onFailure) onFailure(response.error);
          continue;
        }
        // 单块请求同样守数量：模型把一段拆成两段时放弃该块，而不是插半截译文。
        const translation = Array.isArray(response.translations) && response.translations.length === 1
          ? response.translations[0]
          : null;
        if (!translation) continue;
        if (await shouldSkipTranslation(block, translation)) continue;
        insertTranslationBlock(block, translation);
      } catch (error) {
        // 扩展上下文失效意味着后面每一块都必然失败，抛给 processBatch 的 catch 统一置 batchError。
        if (isExtensionContextInvalidated(error)) throw error;
        console.error('AI Translator: Per-block fallback translation failed', error);
        if (onFailure) onFailure(error.message);
      }
    }
  }

  async function filterBlocksByLanguage(blocks) {
    if (!chrome?.i18n?.detectLanguage) return blocks;
    if (!settings.autoDetect) return blocks;

    const keep = new Array(blocks.length).fill(true);
    const tasks = blocks.map((block, index) => ({ block, index }));

    await runWithConcurrency(tasks, async ({ block, index }) => {
      try {
        if (await isTargetLanguageText(block.text)) {
          keep[index] = false;
        }
      } catch (error) {
        console.warn('AI Translator: Language pre-check failed', error);
      }
    }, 8);

    return blocks.filter((_, index) => keep[index]);
  }

  function getInlineTranslationTarget(element) {
    if (!element || element.tagName !== 'LI') return element;

    const children = Array.from(element.children).filter((child) => {
      if (isMathElement(child) || isIconElement(child)) return false;
      return true;
    });

    if (children.length !== 1) return element;

    const child = children[0];
    const inlineTranslationTags = new Set(['A', 'SPAN', 'LABEL', 'BUTTON']);
    if (!inlineTranslationTags.has(child.tagName)) return element;

    const text = child.textContent ? child.textContent.trim() : '';
    if (text.length < 2) return element;

    return child;
  }

  // 把一段可能含 {{n}} 数学占位符的文本追加进容器。
  // 建立 占位符编号 -> 数学条目 的映射，按“译文中实际出现的顺序”还原。
  // 不能依赖 mathElements 的原始下标顺序：翻译（尤其中英语序差异）经常调换公式
  // 前后位置，例如 “each m KV entries in C^a and C^b” → “C^a 和 C^b 中的每 m 个……”，
  // 会把 {{3}} {{4}} 排到 {{2}} 之前。旧实现按原始顺序逐个 indexOf 并截断剩余文本，
  // 一旦顺序被调换，靠前编号的占位符就会把靠后编号的占位符连同其间文本一起吞掉，
  // 导致后者以字面 {{n}} 残留、且对应公式被丢弃（arxiv 页 C^a/C^b 显示为 {{3}}{{4}}）。
  function appendTextWithMath(container, text, mathByNumber) {
    if (!text) return;

    const placeholderRe = /\{\{(\d+)\}\}/g;
    let lastIndex = 0;
    let match;
    while ((match = placeholderRe.exec(text)) !== null) {
      const math = mathByNumber.get(match[1]);
      // 未知编号（模型幻觉出的占位符）：保留为普通文本，随后随 textBefore 一并插入
      if (!math) continue;

      // 添加占位符前的文本
      const textBefore = text.slice(lastIndex, match.index);
      if (textBefore) {
        container.appendChild(document.createTextNode(textBefore));
      }

      // 还原原始数学元素或 LaTeX 文本（每次出现都独立 clone，兼容重复占位符）
      if (math.type === 'text') {
        container.appendChild(document.createTextNode(math.text));
      } else if (math.element) {
        container.appendChild(math.element.cloneNode(true));
      }

      lastIndex = placeholderRe.lastIndex;
    }

    // 添加最后剩余的文本
    const tail = text.slice(lastIndex);
    if (tail) {
      container.appendChild(document.createTextNode(tail));
    }
  }

  // 用 DOM 操作构建译文内容：还原数学公式占位符 {{n}}，并按内联格式标记
  // <a1>…</a1> 克隆原元素重建超链接/内联样式。
  // 不使用 innerHTML：数学元素直接 cloneNode，标记元素浅 clone 后以 DOM API
  // 组装，译文文本一律走 createTextNode，模型输出里的任何 HTML 都不会被解析。
  function buildTranslationContent(container, translatedText, block, prefix = '') {
    const mathElements = (block && block.mathElements) || [];
    const markupElements = (block && block.markupElements) || [];

    // 清理 LLM 可能添加的换行
    let text = translatedText.replace(/\s*\n\s*/g, ' ');

    // 添加前缀（如空格）
    if (prefix) {
      text = prefix + text;
    }

    const mathByNumber = new Map();
    for (const math of mathElements) {
      const m = /^\{\{(\d+)\}\}$/.exec(math.placeholder);
      if (m) mathByNumber.set(m[1], math);
    }

    if (markupElements.length === 0) {
      appendTextWithMath(container, text, mathByNumber);
      return;
    }

    const markupByNumber = new Map();
    for (const mk of markupElements) {
      markupByNumber.set(String(mk.index), mk);
    }

    // 栈式重建：开标记 → 浅 clone 原元素（保留 href/class/style，去掉 id 和
    // on* 属性）并下钻；闭标记 → 弹回。对模型输出保持防御：编号或标签名对不上
    // 的标记当普通文本原样保留；错序的闭标记只弹到对应层；缺失的闭标记到结尾
    // 自动闭合。最坏情况（标记全被模型丢掉）退化为纯文本译文，即今天的行为。
    //
    // 大小写不敏感 + 容空白，是内置 NMT 逼出来的：实测 en→zh-Hans 会把开标记
    // 大写成 `<A1>`（闭标记仍是 `</a1>`）。按小写严格匹配的话，这条链接不但重
    // 建不出来，`<A1>` 四个字符还会原样显示给读者。见 MARKUP_MARKER_RE 处。
    const markerRe = /<\s*(\/?)\s*([a-z]+)\s*(\d+)\s*>/gi;
    // 解析完仍留在正文里的标记残骸（配不上任何一对，上面 continue 掉的那些）不
    // 能直接给读者看，落笔前清掉。只认本块生成过的标签名和编号，见 markupDebrisRe。
    const debrisRe = markupDebrisRe(markupElements);
    const emit = (node, chunk) => {
      appendTextWithMath(node, debrisRe ? chunk.replace(debrisRe, '') : chunk, mathByNumber);
    };
    const stack = [{ node: container, index: null }];
    let lastIndex = 0;
    let match;
    while ((match = markerRe.exec(text)) !== null) {
      const closing = match[1] === '/';
      const entry = markupByNumber.get(match[3]);
      if (!entry || entry.tag !== match[2].toLowerCase()) continue;

      emit(stack[stack.length - 1].node, text.slice(lastIndex, match.index));
      lastIndex = markerRe.lastIndex;

      if (!closing) {
        const el = entry.element.cloneNode(false);
        el.removeAttribute('id');
        for (const attr of Array.from(el.attributes)) {
          if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
        }
        stack[stack.length - 1].node.appendChild(el);
        stack.push({ node: el, index: entry.index });
      } else {
        // findLastIndex：模型把同一编号的开标记重复输出时，闭标记只弹最内层
        const pos = stack.findLastIndex((frame) => frame.index === entry.index);
        if (pos > 0) stack.length = pos;
      }
    }
    emit(stack[stack.length - 1].node, text.slice(lastIndex));
  }

  // 向后兼容的旧签名（悬停/划词翻译仍按 mathElements 数组调用）
  function buildTranslationContentWithMath(container, translatedText, mathElements, prefix = '') {
    buildTranslationContent(container, translatedText, { mathElements }, prefix);
  }

  // 译文插进 DOM 不等于看得见：折叠容器（overflow:hidden + max-height）会把它整条
  // 裁掉。见 content-clip-guard.js。
  function keepTranslationVisible(anchor) {
    if (ctx.keepTranslationVisible) ctx.keepTranslationVisible(anchor);
  }

  // 译文放进 DOM 之后要做的三件事，顺序是有讲究的：
  //   1. 把裁剪它的祖先放开（clip guard）——框可能因此长高，第 2 步要量的是放开
  //      之后的样子；
  //   2. 确认页面真给了它地方站（fit guard，见 content-fit-guard.js）。站不住就
  //      撤掉译文，返回 false；
  //   3. 这时候才轮到“仅显示译文”去藏原文。顺序反了会出现最糟的结果——原文被藏
  //      起来，译文又被撤走，那一块彻底空白。
  //
  // 下面每一处把译文放进 DOM 的分支后面都要跟一次，clip-guard.test.mjs 会数：
  // 插入点比检查点多，就是漏了一处。
  // @param {number} sourceWidthBefore 插译文之前原文块的宽度。fit guard 的横向判据
  //   要「页面原本给这一块多少地方」，插完就量不到了，只能在插之前记下来传进去。
  function finishTranslationInsert(translationEl, sourceWidthBefore) {
    keepTranslationVisible(translationEl);
    // 「仅显示译文」开着时先藏原文再交给 fit guard：框里只剩译文一个人，量出来的
    // 才是它真实的处境。反过来先量就会按「原文 + 译文」的高度白撤一批译文。
    if (isTranslationOnlyActive()) hideSourceForTranslation(translationEl);
    if (ctx.keepTranslationInFlow &&
        !ctx.keepTranslationInFlow(translationEl, sourceWidthBefore)) return false;
    return true;
  }

  // ---- 译文往哪儿插 --------------------------------------------------------
  // 默认插在原文块【后面】当兄弟。三类块不能这么插，共同点是：原文块不只是一段
  // 文字，它还是页面结构、或页面画的那个框的一部分，而兄弟节点分不到那份东西。
  //
  //   - 表格单元格：兄弟 <td> 会给整行多加一列，撑破网格。
  //   - 列表项：兄弟 <li> 是一条幽灵条目——列表长度、li:nth-child、屏读的
  //     「第几项，共几项」全都多算一条。而要压掉它多出来的那个圆点只能上
  //     display:block，那又把译文从条目自己的缩进里拽出去：issue #71 里译文跑到
  //     整个列表的左外侧，既没有圆点也不跟原条目对齐。
  //   - 自己画了框的块（有背景色或背景图，如 alignment.anthropic.com 的
  //     .code-box）：兄弟落在框外面。抄一份页面类名也救不回来——
  //     .ai-translator-inline-block 的 reset 会把 background/border/padding 全抹掉，
  //     结果就是灰框外面挂着一段裸译文，正是 issue #71 的「翻译的内容不在框内」。
  //
  // 插到内部这三件事就都自然成立：页面结构没变，缩进和框都是继承来的。
  const INSIDE_ONLY_TAGS = new Set(['TD', 'TH', 'LI']);
  // 内容模型只收内联内容的元素：往里插 <div> 是非法嵌套，改用 <span>，块级排版由
  // .ai-translator-inline-block 自带的 display:block 提供。
  const PHRASING_CONTENT_TAGS = new Set(
    ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DT', 'LABEL', 'A', 'SPAN', 'BUTTON']);
  // 只有普通块级流才往里插。flex/grid 容器里多一个子节点就是多一个 flex item，
  // 横排时会挤在原文右边——那种块宁可让译文留在外面。
  const IN_FLOW_DISPLAYS = new Set(['block', 'flow-root', 'list-item', 'table-cell']);

  // 元素自己画了一个看得见的框？只认背景（背景色/背景图）：这是「读者眼里这是一个
  // 框」的强信号。单边框线不算——维基百科那种 border-bottom 的标题只是根分隔线，
  // 把译文塞进标题里反而会让分隔线跑到译文下面。
  function paintsOwnBox(computedStyle) {
    const image = computedStyle.backgroundImage;
    if (image && image !== 'none') return true;
    const color = computedStyle.backgroundColor;
    if (!color || color === 'transparent') return false;
    const parsed = color.match(/rgba?\(([^)]+)\)/);
    if (!parsed) return true; // 认不出的颜色语法（color(display-p3 …) 等）：作者设过就算
    const parts = parsed[1].split(',').map((part) => parseFloat(part));
    const alpha = parts.length > 3 ? parts[3] : 1;
    return alpha > 0.02;
  }

  // @returns {{inside: boolean, tag: string}} inside=true 时 tag 是要新建的标签名
  function getTranslationPlacement(element, computedStyle) {
    const style = computedStyle || window.getComputedStyle(element);
    const inside = INSIDE_ONLY_TAGS.has(element.tagName)
      || (paintsOwnBox(style) && IN_FLOW_DISPLAYS.has(style.display));
    return {
      inside,
      tag: PHRASING_CONTENT_TAGS.has(element.tagName) ? 'span' : 'div'
    };
  }

  // 插入翻译块
  function insertTranslationBlock(block, translation) {
    const element = block.element;
    if (!element || !element.parentNode) return;

    // 检查是否已经翻译过，防止重复
    if (element.classList.contains('ai-translator-translated')) return;
    if (element.classList.contains('ai-translator-inline-source')) return;

    // 标记为已翻译
    element.classList.add('ai-translator-translated');

    const hasMathElements = block.mathElements && block.mathElements.length > 0;
    const hasMarkupElements = block.markupElements && block.markupElements.length > 0;
    const hasRichContent = hasMathElements || hasMarkupElements;

    // 受管容器（只读的 Lexical / ProseMirror 等）会删掉插进子树的译文节点，这里
    // 把译文画成原文块自己的 ::after —— 生成内容不是节点，编辑器看不见它，而且它
    // 占真实排版空间，后面的段落被顶下去而不是被盖住。见 content-managed-translation.js。
    // 收集阶段已经用同一条判据筛过一遍，画不出来的块根本不会走到这里。
    if (ctx.isInsideManagedDomRoot && ctx.isInsideManagedDomRoot(element) &&
        ctx.canRenderManagedTranslation &&
        ctx.canRenderManagedTranslation(element, { hasMath: hasMathElements })) {
      // ::after 的 content 只能是纯文本，内联格式标记在这里还原不了，剥掉了事。
      // 用 markupDebrisRe 而不是笼统的 MARKUP_MARKER_RE：只剥本块真生成过的标签
      // 名+编号，正文本来就含 <b2> 这类字样的页面（HTML 教程等）不会被误删。
      const managedDebrisRe = markupDebrisRe(block.markupElements);
      ctx.renderManagedTranslation(
        element,
        managedDebrisRe ? translation.replace(managedDebrisRe, '') : translation,
        {}
      );
      // ::after 把原文块撑高，撑出去的那部分同样可能被折叠祖先裁掉，量原文块
      keepTranslationVisible(element);
      return;
    }

    // 页面原本给这一块多少横向空间。插完就问不到了（收缩包裹的框会被译文自己撑宽），
    // fit guard 的横向判据要的就是这个数，所以在动 DOM 之前量。
    const sourceWidthBefore = element.getBoundingClientRect().width;

    // 检测是否在水平布局中
    const isHorizontalFlex = isHorizontalFlexParent(element);
    const inlineTarget = isHorizontalFlex ? getInlineTranslationTarget(element) : element;

    // 复制所有关键样式，包括颜色
    const computedStyle = window.getComputedStyle(inlineTarget);
    const baseStyle = `
      font-size: ${computedStyle.fontSize};
      font-family: ${computedStyle.fontFamily};
      font-weight: ${computedStyle.fontWeight};
      line-height: ${computedStyle.lineHeight};
      text-align: ${computedStyle.textAlign};
      color: ${computedStyle.color};
      letter-spacing: ${computedStyle.letterSpacing};
      opacity: 0.85;
    `;

    if (isHorizontalFlex) {
      // 对于水平 flex 布局（如顶部导航），将翻译插入到元素内部
      // 翻译显示在原文右侧（inline），保持菜单栏高度不变
      const translationEl = document.createElement('span');
      translationEl.className = 'ai-translator-inline-block ai-translator-inline-right';

      if (hasRichContent) {
        // 使用 DOM 操作构建内容，不用 innerHTML
        buildTranslationContent(translationEl, translation, block, ' ');
      } else {
        translationEl.textContent = ' ' + translation;
      }

      translationEl.style.cssText = `
        font-size: 0.85em;
        font-family: ${computedStyle.fontFamily};
        font-weight: ${computedStyle.fontWeight};
        line-height: ${computedStyle.lineHeight};
        color: ${computedStyle.color};
        letter-spacing: ${computedStyle.letterSpacing};
        opacity: 0.7;
        display: inline;
        margin: 0;
        padding: 0;
      `;

      // 将翻译作为子元素追加到原元素内部（显示在原文右侧）
      inlineTarget.appendChild(translationEl);
      finishTranslationInsert(translationEl, sourceWidthBefore);
    } else {
      // 对于非水平 flex 布局（如侧边栏），默认插入为同级元素；
      // 哪些块只能往内部插、插什么标签，见 getTranslationPlacement
      const placement = getTranslationPlacement(element, computedStyle);
      const translationEl = document.createElement(placement.inside ? placement.tag : element.tagName);

      // 复制原始元素的类名，保留页面的 CSS 样式（如 ltx_p 用于 MathML 内联显示）
      // 然后添加我们的标记类
      // 需要移除位置相关的类，避免破坏布局（如 absolute, fixed, inset-* 等）
      // 往内部插时不复制：单元格专属样式（列宽/对齐）会带歪译文块，而页面画的那个框
      // 会在框里再画一个一模一样的框——内部译文要的样式本来就是继承来的
      if (element.className && !placement.inside) {
        const positionClasses = /\b(absolute|fixed|sticky|relative|inset-\S*|top-\S*|bottom-\S*|left-\S*|right-\S*|z-\S*)\b/g;
        translationEl.className = element.className
          .replace('ai-translator-translated', '')
          .replace(positionClasses, '')
          .trim();
      }
      translationEl.classList.add('ai-translator-inline-block');

      if (hasRichContent) {
        // 使用 DOM 操作构建内容，不用 innerHTML
        buildTranslationContent(translationEl, translation, block);
      } else {
        translationEl.textContent = translation;
      }
      if (hasMathElements) {
        // 有数学公式时，尽量少设置内联样式，让页面 CSS 控制布局
        // 只设置 opacity 来区分译文
        translationEl.style.opacity = '0.85';
      } else {
        // 无数学公式时，设置完整样式（含只带内联标记的富文本块——克隆出来的
        // 链接/强调元素自带类名，页面 CSS 会在 baseStyle 之上继续生效）。
        // 注意：不要在这里设置水平 margin。有些页面通过在原元素上设置
        // `margin-left/right: auto` 让每个块居中（例如 Anthropic 文章的
        // `.prose > *`），一旦强制 `margin: 0` 就会把译文钉在容器左侧，而原文
        // 仍然居中，导致译文错位到左边。上下间距由 `.ai-translator-inline-block`
        // 类（带 !important）控制。
        translationEl.style.cssText = baseStyle + `
          padding: 0;
          box-sizing: border-box;
        `;
      }

      // 页面用【负的下外边距】把相邻块吸到一起时（alignment.anthropic.com 的
      // `.code-box p { margin: -12px 0 }` 就是拿来抵消 <br> 的），兄弟译文会被同一条
      // 规则吸进原文里，两行字直接叠在一块。相邻外边距的合并值是
      // max(正) + min(负)，所以补偿要补到「负的那一截 + 我们本来的行间距」，
      // 只补正好抵消的量仍然会贴着原文。
      if (!placement.inside) {
        const sourceMarginBottom = parseFloat(computedStyle.marginBottom) || 0;
        if (sourceMarginBottom < 0) {
          const gap = (parseFloat(computedStyle.fontSize) || 16) * 0.15;
          translationEl.style.setProperty(
            'margin-top', `${Math.round(-sourceMarginBottom + gap)}px`, 'important');
        }
      }

      // 计算原文文本相对于元素的偏移量（跳过 icon 等前置元素）
      const textOffset = getTextOffsetLeft(element, { fromContentBox: placement.inside });

      // 使用 setProperty 设置 padding-left，加 !important 防止被页面 CSS 覆盖
      if (textOffset > 0) {
        translationEl.style.setProperty('padding-left', `${textOffset}px`, 'important');
      }

      // 检查元素是否有 slot 属性（Web Components 的内容分发机制）
      // 如果有 slot 属性，在元素旁边插入兄弟元素会破坏 Shadow DOM 的结构
      // 应该将翻译追加到元素内部
      const hasSlotAttr = element.hasAttribute('slot');
      if (hasSlotAttr) {
        // 对于有 slot 属性的元素，将翻译作为子元素追加到内部
        // 使用 span 而不是复制标签名，避免嵌套问题（如 a > a）
        const internalTranslation = document.createElement('span');
        internalTranslation.className = 'ai-translator-inline-block';
        if (hasRichContent) {
          buildTranslationContent(internalTranslation, translation, block);
        } else {
          internalTranslation.textContent = translation;
        }
        internalTranslation.style.cssText = baseStyle + `
          display: block;
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        `;
        element.appendChild(internalTranslation);
        finishTranslationInsert(internalTranslation, sourceWidthBefore);
      } else if (placement.inside) {
        // 译文作为块级子节点追加到原文块【内部】，显示在原内容下方。
        // 用 <div>/<span>（而非复制标签名）避免 td 内嵌 td、li 内嵌 li 这类非法结构。
        element.appendChild(translationEl);
        finishTranslationInsert(translationEl, sourceWidthBefore);
      } else {
        // 插入到原元素后面
        element.after(translationEl);
        finishTranslationInsert(translationEl, sourceWidthBefore);
      }
    }
  }

  function showPageTranslationProgress() {
    let progressEl = document.getElementById('ai-translator-progress');
    if (!progressEl) {
      progressEl = document.createElement('div');
      progressEl.id = 'ai-translator-progress';
      progressEl.innerHTML = `
        <div class="ai-translator-progress-content">
          <div class="ai-translator-progress-header">
            <span class="ai-translator-progress-text">${t('translatingProgress')}</span>
            <span class="ai-translator-progress-percent">0%</span>
          </div>
          <div class="ai-translator-progress-track">
            <div class="ai-translator-progress-bar"></div>
          </div>
        </div>
        <button class="ai-translator-progress-close" title="${t('closeTranslation')}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      `;
      document.body.appendChild(progressEl);
      
      // 定位到翻译球下方
      positionProgressBar();
      
      // 添加关闭按钮事件 - 使用 mousedown 确保在拖动逻辑之前触发
      const closeBtn = progressEl.querySelector('.ai-translator-progress-close');
      closeBtn.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();
      });
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        forceHideProgressBar();
      });
      
      // 添加拖动功能
      setupProgressBarDrag(progressEl);
    }
  }

  function setupProgressBarDrag(progressEl) {
    let isDragging = false;
    let startX, startY, initialX, initialY;

    progressEl.addEventListener('mousedown', (e) => {
      // 忽略关闭按钮点击
      if (e.target.classList.contains('ai-translator-progress-close')) return;
      
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      
      const rect = progressEl.getBoundingClientRect();
      initialX = rect.left;
      initialY = rect.top;
      
      progressEl.classList.add('dragging');
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;

      const deltaX = e.clientX - startX;
      const deltaY = e.clientY - startY;

      let newX = initialX + deltaX;
      let newY = initialY + deltaY;

      // 保持在视口内
      const progressWidth = 220;
      const progressHeight = 60;
      newX = Math.max(0, Math.min(window.innerWidth - progressWidth, newX));
      newY = Math.max(0, Math.min(window.innerHeight - progressHeight, newY));

      progressEl.style.left = `${newX}px`;
      progressEl.style.top = `${newY}px`;
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        progressEl.classList.remove('dragging');
      }
    });
  }

  function positionProgressBar() {
    const progressEl = document.getElementById('ai-translator-progress');
    if (!progressEl || !state.floatBall) return;
    
    const ballRect = state.floatBall.getBoundingClientRect();
    const progressWidth = 220;
    
    let left = ballRect.left + (ballRect.width / 2) - (progressWidth / 2);
    let top = ballRect.bottom + 12;
    
    // 确保不超出屏幕
    if (left < 10) left = 10;
    if (left + progressWidth > window.innerWidth - 10) {
      left = window.innerWidth - progressWidth - 10;
    }
    if (top + 60 > window.innerHeight) {
      top = ballRect.top - 70;
    }
    
    progressEl.style.left = `${left}px`;
    progressEl.style.top = `${top}px`;
  }

  function forceHideProgressBar() {
    const progressEl = document.getElementById('ai-translator-progress');
    if (progressEl) {
      progressEl.classList.add('ai-translator-progress-done');
      setTimeout(() => progressEl.remove(), 300);
    }
    // 注意：不重置 state.isTranslatingPage，翻译任务可能还在后台运行
    // state.isTranslatingPage 只在翻译真正完成时才重置（在 finally 块中）
  }

  function showTranslatingHint(progressEl) {
    if (!progressEl) return;
    
    // 避免重复触发
    if (progressEl.classList.contains('ai-translator-progress-hint')) return;
    
    const textEl = progressEl.querySelector('.ai-translator-progress-text');
    if (!textEl) return;
    
    const originalText = textEl.textContent;
    
    // 添加闪烁动画类
    progressEl.classList.add('ai-translator-progress-hint');
    
    // 淡出当前文字
    textEl.classList.add('ai-translator-text-fade-out');
    
    setTimeout(() => {
      // 切换文字并淡入
      textEl.textContent = t('pleaseWait');
      textEl.classList.remove('ai-translator-text-fade-out');
      textEl.classList.add('ai-translator-text-fade-in');
      
      // 1.2秒后淡出提示文字
      setTimeout(() => {
        textEl.classList.remove('ai-translator-text-fade-in');
        textEl.classList.add('ai-translator-text-fade-out');
        
        setTimeout(() => {
          // 切换回原文字并淡入
          textEl.textContent = originalText;
          textEl.classList.remove('ai-translator-text-fade-out');
          textEl.classList.add('ai-translator-text-fade-in');
          progressEl.classList.remove('ai-translator-progress-hint');
          
          setTimeout(() => {
            textEl.classList.remove('ai-translator-text-fade-in');
          }, 200);
        }, 200);
      }, 1200);
    }, 200);
  }

  // 进度条位置上的一条提示。原来只用来说“页面已翻译”，现在还要说“正文翻不了”，
  // 所以文案由调用方给，函数名也不再替它下结论。
  function showPageNotice(message) {
    const text = escapeHtml(message);
    const progressEl = document.getElementById('ai-translator-progress');
    if (progressEl) {
      progressEl.innerHTML = `
        <div class="ai-translator-progress-content ai-translator-progress-info">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
            <path d="M12 16v-4M12 8h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          <span>${text}</span>
        </div>
        <button class="ai-translator-progress-close" title="${t('close')}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      `;
      progressEl.classList.add('ai-translator-progress-info-state');
      
      // 重新绑定关闭按钮事件
      const closeBtn = progressEl.querySelector('.ai-translator-progress-close');
      closeBtn.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();
      });
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        forceHideProgressBar();
      });
      
      // 3秒后自动关闭
      setTimeout(() => {
        if (progressEl.parentNode) {
          progressEl.classList.add('ai-translator-progress-done');
          setTimeout(() => {
            if (progressEl.parentNode) progressEl.remove();
          }, 300);
        }
      }, 3000);
    }
  }

  function showTranslationError(errorMessage) {
    const progressEl = document.getElementById('ai-translator-progress');
    if (progressEl) {
      // Escape HTML in error message
      const escapedMessage = escapeHtml(errorMessage);

      progressEl.innerHTML = `
        <div class="ai-translator-progress-content ai-translator-progress-error">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
            <path d="M12 8v5M12 16h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          <div class="ai-translator-progress-error-text">${escapedMessage}</div>
        </div>
        <button class="ai-translator-progress-close" title="${t('close')}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      `;
      progressEl.classList.remove('ai-translator-progress-info-state');
      progressEl.classList.add('ai-translator-progress-error-state');

      // Rebind close button event
      const closeBtn = progressEl.querySelector('.ai-translator-progress-close');
      closeBtn.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();
      });
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        forceHideProgressBar();
      });

      // Auto close after 8 seconds (longer for errors so user can read)
      setTimeout(() => {
        if (progressEl.parentNode) {
          progressEl.classList.add('ai-translator-progress-done');
          setTimeout(() => {
            if (progressEl.parentNode) progressEl.remove();
          }, 300);
        }
      }, 8000);
    }
  }

  function updatePageTranslationProgress(current, total) {
    const progressBar = document.querySelector('#ai-translator-progress .ai-translator-progress-bar');
    const progressPercent = document.querySelector('#ai-translator-progress .ai-translator-progress-percent');
    if (progressBar && progressPercent) {
      const percent = Math.round((current / total) * 100);
      progressBar.style.width = `${percent}%`;
      progressPercent.textContent = `${percent}%`;
    }
  }

  // 语言包首次下载是几十 MB 级别的，期间一条译文都出不来。不给反馈的话进度条会
  // 卡在 0% 好一阵子，看起来像卡死了，所以把下载进度借同一条进度条显示出来。
  ctx.onBuiltinDownloadProgress = function(loaded) {
    const textEl = document.querySelector('#ai-translator-progress .ai-translator-progress-text');
    const percentEl = document.querySelector('#ai-translator-progress .ai-translator-progress-percent');
    const barEl = document.querySelector('#ai-translator-progress .ai-translator-progress-bar');
    if (!textEl || !percentEl || !barEl) return;

    const pct = Math.max(0, Math.min(100, Math.round((loaded || 0) * 100)));
    if (pct >= 100) {
      ctx.onBuiltinDownloadEnded();
      return;
    }
    textEl.textContent = t('builtinDownloading');
    percentEl.textContent = `${pct}%`;
    barEl.style.width = `${pct}%`;
  };

  // 下载这一程结束了——下完了、失败了、或者卡住被放弃了。三种情况后面都轮到翻译
  // 继续走（内置或回落到 AI），所以进度条必须还回去，否则它会停在“正在下载语言包
  // 45%”上，而页面其实早就在用另一条路翻译了。
  ctx.onBuiltinDownloadEnded = function() {
    const textEl = document.querySelector('#ai-translator-progress .ai-translator-progress-text');
    if (!textEl) return;
    textEl.textContent = t('translatingProgress');
    updatePageTranslationProgress(state.translationProgress.current, state.translationProgress.total || 1);
  };

  function hidePageTranslationProgress() {
    const progressEl = document.getElementById('ai-translator-progress');
    if (progressEl) {
      // 显示成功状态，保留关闭按钮
      progressEl.innerHTML = `
        <div class="ai-translator-progress-content ai-translator-progress-success">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path d="M7.5 12.5L10.5 15.5L16.5 9.5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
            <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
          </svg>
          <span>${t('translationComplete')}</span>
        </div>
        <button class="ai-translator-progress-close" title="${t('close')}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      `;
      progressEl.classList.add('ai-translator-progress-success-state');
      
      // 重新绑定关闭按钮事件
      const closeBtn = progressEl.querySelector('.ai-translator-progress-close');
      closeBtn.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();
      });
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        forceHideProgressBar();
      });
      
      // 5秒后自动关闭
      setTimeout(() => {
        if (progressEl.parentNode) {
          progressEl.classList.add('ai-translator-progress-done');
          setTimeout(() => {
            if (progressEl.parentNode) progressEl.remove();
          }, 300);
        }
      }, 5000);
    }
  }

  ctx.translatePage = translatePage;
  ctx.getTextWithMathPlaceholders = getTextWithMathPlaceholders;
  ctx.buildTranslationContentWithMath = buildTranslationContentWithMath;
  ctx.buildTranslationContent = buildTranslationContent;
  ctx.applyTranslationOnlyMode = applyTranslationOnlyMode;
  // content-fit-guard.js 用：挤不下两种语言时让原文，撤译文时把原文放回来
  ctx.hideCrowdedSource = hideCrowdedSource;
  ctx.releaseSourceForTranslation = releaseSourceForTranslation;
  // 内联格式标记的唯一定义，content-language.js 剥标记时复用
  ctx.MARKUP_MARKER_RE = MARKUP_MARKER_RE;
  ctx.isMathElement = isMathElement;
  ctx.isIconElement = isIconElement;
  ctx.isHorizontalFlexParent = isHorizontalFlexParent;
  ctx.getInlineTranslationTarget = getInlineTranslationTarget;
  ctx.getTextOffsetLeft = getTextOffsetLeft;
  ctx.getTranslationPlacement = getTranslationPlacement;
  ctx.TEXT_RUN_CLASS = TEXT_RUN_CLASS;
  ctx.collectTranslatableBlocks = collectTranslatableBlocks;
  ctx.insertTranslationBlock = insertTranslationBlock;
  // 单元测试直接驱动这条“译文数量必须与块数一致”的守卫
  // （test/unit/fast-batch-alignment.test.mjs），不必伪造整条整页翻译流水线。
  ctx.applyFastBatchTranslations = applyFastBatchTranslations;
  // 内置翻译引擎撞到输入配额上限时要把长文本切开重试，复用这里的切块器，
  // 它保证不会把 {{n}} 数学占位符从中间切断。
  ctx.splitTextIntoChunks = splitTextIntoChunks;
})();
