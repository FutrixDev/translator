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
  const CONCURRENCY = 12;       // 并发数
  const DELIMITER = '⟪⟫⟪⟫⟪⟫';   // 分隔符（使用 Unicode 数学括号，极不可能出现在正文中）

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
      
      if (translatableBlocks.length === 0) {
        state.pageHasBeenTranslated = true;
        showAlreadyTranslatedMessage();
        state.isTranslatingPage = false;
        return;
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

      // Track if any batch failed
      let batchError = null;

      // 使用 Promise 池进行并发控制
      const processBatch = async (batch) => {
        // Skip if we already have an error
        if (batchError) return;
        if (!isExtensionContextAvailable()) {
          batchError = t('extensionContextInvalidated');
          return;
        }

        const texts = batch.map(item => item.text);

        try {
          const response = await chrome.runtime.sendMessage({
            type: 'TRANSLATE_BATCH_FAST',
            texts: texts,
            targetLang: getEffectiveTargetLang(),
            delimiter: DELIMITER
          });

          // Check for error in response
          if (response.error) {
            batchError = response.error;
            throw new Error(response.error);
          }

          if (response.translations) {
            const insertTasks = response.translations.map(async (translation, i) => {
              if (!batch[i] || !translation) return;
              if (await shouldSkipTranslation(batch[i], translation)) return;
              insertTranslationBlock(batch[i], translation);
            });
            await Promise.all(insertTasks);
          }
        } catch (error) {
          console.error('AI Translator: Batch translation failed', error);
          if (!batchError) {
            batchError = isExtensionContextInvalidated(error)
              ? t('extensionContextInvalidated')
              : (error.message || t('translationFailed'));
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
    if (hidden.length > 0) {
      state.translationsVisible = true;
    }
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

  // 智能分批：根据 token/字符数/段落数限制
  function createSmartBatches(blocks) {
    const batches = [];
    let currentBatch = [];
    let currentChars = 0;
    let currentTokens = 0;
    const itemTokenOverhead = 6;

    for (const block of blocks) {
      const textLen = block.text.length;
      const tokenEstimate = estimateTokens(block.text) + itemTokenOverhead;
      
      // 如果当前批次加入这个 block 后会超限，先保存当前批次
      if (currentBatch.length > 0 && 
          (currentTokens + tokenEstimate > MAX_BATCH_TOKENS ||
           currentChars + textLen > MAX_BATCH_CHARS ||
           currentBatch.length >= MAX_BATCH_ITEMS)) {
        batches.push(currentBatch);
        currentBatch = [];
        currentChars = 0;
        currentTokens = 0;
      }
      
      currentBatch.push(block);
      currentChars += textLen;
      currentTokens += tokenEstimate;
    }
    
    // 保存最后一个批次
    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }
    
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
    const blocks = [];
    const blockTags = ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TD', 'TH', 'FIGCAPTION', 'BLOCKQUOTE', 'DT', 'DD'];
    // 内联可翻译元素 - 这些元素即使不是块级也应单独翻译
    const inlineTags = ['A', 'SPAN', 'LABEL', 'BUTTON'];
    const skipTags = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'TEXTAREA', 'INPUT', 'SELECT', 'CODE', 'PRE', 'SVG', 'CANVAS', 'KBD', 'SAMP', 'VAR', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR'];
    // 容器元素 - 这些元素不应作为整体翻译，应递归处理子元素
    const containerTags = ['NAV', 'UL', 'OL', 'DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'HEADER', 'FOOTER', 'MAIN'];
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
      if (element.closest('.ai-translator-popup, .ai-translator-translated, .ai-translator-inline-source, .ai-translator-inline-block, #ai-translator-float-ball, #ai-translator-float-menu, #ai-translator-progress, #ai-translator-selection-btn')) return;
      if (element.classList.contains('ai-translator-translated')) return;
      if (element.classList.contains('ai-translator-inline-source')) return;

      // 跳过被 skipTags 包含的元素
      if (element.closest(skipTags.map(t => t.toLowerCase()).join(','))) return;

      // 跳过代码块容器
      if (element.closest('.highlight, .codehilite, .sourceCode, .code-block, [class*="language-"], [class*="highlight"]')) return;

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
          for (const child of element.children) {
            processElement(child);
          }
          return;
        }
      }

      // 对于内联元素（如链接、按钮），如果有文本内容，单独翻译
      if (inlineTags.includes(tagName)) {
        const { text, mathElements } = getTextWithMathPlaceholders(element);
        if (text && text.length >= 2 && text.length <= 500) {
          // 跳过看起来像代码或主要是URL的文本
          const textWithoutMath = text.replace(/\{\{\d+\}\}/g, '');
          if (textWithoutMath && !looksLikeCode(textWithoutMath) && !isMainlyUrl(textWithoutMath)) {
            blocks.push({
              element: element,
              text: text,
              tagName: tagName,
              mathElements: mathElements
            });
            return;
          }
        }
      }

      // 对于块级元素
      if (blockTags.includes(tagName) || hasDirectText) {
        const { text, mathElements } = getTextWithMathPlaceholders(element);
        if (text && text.length >= 2 && text.length <= 2000) {
          // 跳过看起来像代码或主要是URL的文本（排除数学占位符后判断）
          const textWithoutMath = text.replace(/\{\{\d+\}\}/g, '');
          if (textWithoutMath && (looksLikeCode(textWithoutMath) || isMainlyUrl(textWithoutMath))) {
            // 递归处理子元素，可能有非代码/非URL的部分
            for (const child of element.children) {
              processElement(child);
            }
            return;
          }

          blocks.push({
            element: element,
            text: text,
            tagName: tagName,
            mathElements: mathElements // 保存公式信息
          });
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

  // 获取元素内容，用占位符替换数学公式（图标直接跳过）
  // 返回 { text: string, mathElements: Array<{placeholder: string, type: string, element?: Element, text?: string}> }
  // 注意：mathElements 保存 DOM 引用或 LaTeX 文本，用于后续还原
  function getTextWithMathPlaceholders(element) {
    let text = '';
    const mathElements = [];
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

        // 递归处理子节点
        for (const child of node.childNodes) {
          processNode(child);
        }
      }
    }

    for (const child of element.childNodes) {
      processNode(child);
    }

    return { text: text.trim(), mathElements };
  }

  // 获取元素的直接文本内容（向后兼容）
  function getDirectTextContent(element) {
    const { text } = getTextWithMathPlaceholders(element);
    return text;
  }

  // 获取元素内文本相对于元素左边界的偏移量（跳过 icon/svg 等前置元素）
  function getTextOffsetLeft(element) {
    const elementRect = element.getBoundingClientRect();
    if (elementRect.width === 0) return 0;

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
      return Math.max(0, textRect.left - elementRect.left);
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
    if (normalizedOriginal && normalizedOriginal === normalizedTranslation) {
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

  // 用 DOM 操作构建包含数学公式的译文内容
  // 不使用 innerHTML，直接用 cloneNode 复制原始数学元素，避免 HTML 序列化问题
  function buildTranslationContentWithMath(container, translatedText, mathElements, prefix = '') {
    // 清理 LLM 可能添加的换行
    let text = translatedText.replace(/\s*\n\s*/g, ' ');

    // 添加前缀（如空格）
    if (prefix) {
      text = prefix + text;
    }

    // 按占位符拆分文本，逐个插入文本节点和数学元素
    let remaining = text;

    for (const math of mathElements) {
      const placeholderIndex = remaining.indexOf(math.placeholder);
      if (placeholderIndex === -1) {
        // 占位符未找到，可能被 LLM 删除了，跳过
        continue;
      }

      // 添加占位符前的文本
      const textBefore = remaining.substring(0, placeholderIndex);
      if (textBefore) {
        container.appendChild(document.createTextNode(textBefore));
      }

      // 添加原始数学元素或 LaTeX 文本
      if (math.type === 'text') {
        container.appendChild(document.createTextNode(math.text));
      } else if (math.element) {
        const mathClone = math.element.cloneNode(true);
        container.appendChild(mathClone);
      }

      // 更新剩余文本
      remaining = remaining.substring(placeholderIndex + math.placeholder.length);
    }

    // 添加最后剩余的文本
    if (remaining) {
      container.appendChild(document.createTextNode(remaining));
    }
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

    const hasMathElements = block.mathElements && block.mathElements.length > 0;

    if (isHorizontalFlex) {
      // 对于水平 flex 布局（如顶部导航），将翻译插入到元素内部
      // 翻译显示在原文右侧（inline），保持菜单栏高度不变
      const translationEl = document.createElement('span');
      translationEl.className = 'ai-translator-inline-block ai-translator-inline-right';

      if (hasMathElements) {
        // 使用 DOM 操作构建内容，不用 innerHTML
        buildTranslationContentWithMath(translationEl, translation, block.mathElements, ' ');
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
    } else {
      // 对于非水平 flex 布局（如侧边栏），插入为同级元素
      const translationEl = document.createElement(element.tagName);

      // 复制原始元素的类名，保留页面的 CSS 样式（如 ltx_p 用于 MathML 内联显示）
      // 然后添加我们的标记类
      // 需要移除位置相关的类，避免破坏布局（如 absolute, fixed, inset-* 等）
      if (element.className) {
        const positionClasses = /\b(absolute|fixed|sticky|relative|inset-\S*|top-\S*|bottom-\S*|left-\S*|right-\S*|z-\S*)\b/g;
        translationEl.className = element.className
          .replace('ai-translator-translated', '')
          .replace(positionClasses, '')
          .trim();
      }
      translationEl.classList.add('ai-translator-inline-block');

      if (hasMathElements) {
        // 使用 DOM 操作构建内容，不用 innerHTML
        buildTranslationContentWithMath(translationEl, translation, block.mathElements);
        // 有数学公式时，尽量少设置内联样式，让页面 CSS 控制布局
        // 只设置 opacity 来区分译文
        translationEl.style.opacity = '0.85';
      } else {
        translationEl.textContent = translation;
        // 无数学公式时，设置完整样式。
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

      // 计算原文文本相对于元素的偏移量（跳过 icon 等前置元素）
      const textOffset = getTextOffsetLeft(element);

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
        internalTranslation.textContent = translation;
        internalTranslation.style.cssText = baseStyle + `
          display: block;
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        `;
        element.appendChild(internalTranslation);
      } else {
        // 插入到原元素后面
        element.after(translationEl);
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

  function showAlreadyTranslatedMessage() {
    const progressEl = document.getElementById('ai-translator-progress');
    if (progressEl) {
      progressEl.innerHTML = `
        <div class="ai-translator-progress-content ai-translator-progress-info">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
            <path d="M12 16v-4M12 8h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          <span>${t('pageAlreadyTranslated')}</span>
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
  ctx.isMathElement = isMathElement;
  ctx.isIconElement = isIconElement;
  ctx.isHorizontalFlexParent = isHorizontalFlexParent;
  ctx.getInlineTranslationTarget = getInlineTranslationTarget;
  ctx.getTextOffsetLeft = getTextOffsetLeft;
})();
