// Blab Translation — 整页翻译：分批与翻译轮次
//
// 一组块进来，译文落到页面上：按首屏排序、按 token/字符/条数分批、并发跑、
// 失败到什么程度算整体故障。runTranslationPass 是这一轮的全部，
// 它不碰进度条也不管“页面已翻译”那类状态——那些是调用方的事
// （content/content-page-translation.js）。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const { settings } = ctx;
  const t = ctx.t;
  const isExtensionContextAvailable = ctx.isExtensionContextAvailable;
  const isExtensionContextInvalidated = ctx.isExtensionContextInvalidated;
  const getEffectiveTargetLang = ctx.getEffectiveTargetLang;
  const getLangBase = ctx.getLangBase;
  // 「这两门语言算一门吗」的判定在 shared/lang-tags.js，由 content-language.js
  // 转手到 ctx 上。和上面一行一样在这里取，少装一个模块的症状才一致。
  const isSameLanguage = ctx.isSameLanguage;
  const getLanguageDetectionText = ctx.getLanguageDetectionText;
  const MAX_BATCH_CHARS = 9000; // 每批次最大字符数（加大以减少请求）
  const MAX_BATCH_ITEMS = 40;   // 每批次最大段落数（加大以减少请求）
  const MAX_BATCH_TOKENS = 3200; // 估算 token 上限（输入侧保守值）
  const MAX_BLOCK_CHARS = 4000; // 单个块最大字符数；超过则按标点分块（见 splitTextIntoChunks），避免正文被丢弃或被模型截断
  // 并发按引擎分：内置引擎在批内是串行的（content-translation-engine.js 的
  // `for (const text of texts) await translateWithBuiltin(...)`），12 路并发只是让
  // 12 个批同时去抢同一份端上模型，多出来的是排队和内存，不是吞吐；云端引擎
  // 是网络并发，12 才有意义。
  const CONCURRENCY = Object.freeze({ builtin: 4, ai: 12 });
  const DELIMITER = '⟪⟫⟪⟫⟪⟫';   // 分隔符（使用 Unicode 数学括号，极不可能出现在正文中）

  // 整页翻译的所有请求走缓存层（content/content-translation-cache.js），
  // 它与 ctx.requestTranslation 同形，只是先去缓存里看一眼。没加载到它就走原路：
  // 单元测试只装 content/page/* 这几个模块，那里翻译照常跑，只是不省请求。
  const requestBatch = (message) =>
    (ctx.requestTranslationCached || ctx.requestTranslation)(message);

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

  async function detectLanguage(text) {
    if (!chrome?.i18n?.detectLanguage) return null;
    return new Promise((resolve) => {
      chrome.i18n.detectLanguage(text, resolve);
    });
  }

  // 采信一次语言判定的门槛。**全仓只有这一处。** 自动翻译的调度层也要判语言
  // （这一页整体是什么语言，该不该自己动手），第二套阈值意味着「这段不用翻」和
  // 「这页不用翻」会在同一份文本上给出不同答案。
  const LANGUAGE_CONFIDENCE_MIN = 85;

  /**
   * 这段文字是什么语言 —— 只在够有把握时回答。
   *
   * 回的是**整码**（'en'、'zh-CN'、'zh-TW' …），不砍成基码。chrome.i18n 的
   * 检测器本来就分得出简繁，砍掉那个子标签就等于把这个区别丢在这里：一份繁体
   * 的正文配简体的目标语言，下一步会认成「本来就是目标语言」，整页一个字也不
   * 翻——而那正是用户要的那一件事。要基码的调用方自己取（getLangBase 在
   * shared/lang-tags.js），因为砍了就再也接不回来。
   *
   * @returns {Promise<?string>} 语言标签，判不出或不够有把握时 null
   */
  async function detectReliableLanguage(text) {
    const detectText = getLanguageDetectionText(text);
    if (detectText.length < 4) return null;

    const result = await detectLanguage(detectText);
    const topLang = result?.languages?.[0];
    if (!topLang) return null;

    const confidence = typeof topLang.percentage === 'number' ? topLang.percentage : 0;
    if (confidence < LANGUAGE_CONFIDENCE_MIN || result.isReliable === false) return null;

    return topLang.language || null;
  }

  // 一轮翻译只认一门语言 —— 开跑那一刻定下来，之后这一轮里谁都不再去问设置。
  //
  // 两个读数，都要，且必须取自同一时刻：
  //
  //   request —— 发给引擎的那一门。getEffectiveTargetLang 会把「跟随浏览器」补成
  //              具体语言，因为请求里非填一个不可。
  //   stamp   —— 记进译文身份的那一门。currentTargetLang 的空串**就是**「跟随浏
  //              览器」这个哨兵，登记端和比对端同读同写，补了反而对不上。
  //
  // 为什么不各用各的、现用现问：用户在一轮翻译跑到一半时改了目标语言，早发出去
  // 的那几批拿回来的是旧语言的译文，现问就会给它们盖上新语言的戳；下一轮一看
  // 「语言没变」把这些块全跳过，旧语言的译文就永远留在页面上了。反过来（请求用
  // 新的、戳按旧的）只是白翻一轮，不会留下错的东西 —— 但两个读数同源，两种都
  // 不会发生：这一轮整个是旧语言的，改设置由 RESTART_KEYS 另起一轮来接。
  function passTarget() {
    return {
      request: getEffectiveTargetLang(),
      stamp: ctx.currentTargetLang ? ctx.currentTargetLang() : null
    };
  }

  // 默认现问设置，是给**一轮开跑之前**的那个调用点留的（filterBlocksByLanguage：
  // 那时候还没有「这一轮」，现问就是对的）。一轮之内的调用一律把 target.request
  // 传进来 —— 那一门在开跑时就定死了，见 passTarget。
  async function isTargetLanguageText(text, targetLang = getEffectiveTargetLang()) {
    if (!getLangBase(targetLang)) return false;
    // 比整码，走的是和字幕引擎、和自动翻译决策层同一个判定
    // （shared/lang-tags.js）。曾经这里比基码而字幕那边比整码：一页 zh-TW 的正文
    // 配 zh-CN 的目标，字幕翻、正文不翻，同一个问题两条路两个答案。
    return isSameLanguage(await detectReliableLanguage(text), targetLang);
  }

  async function shouldSkipTranslation(block, translation, target) {
    const normalizedOriginal = ctx.normalizeComparableText(block.text);
    const normalizedTranslation = ctx.normalizeComparableText(translation);

    // 原文除公式占位符/空白外没有任何正文时，一律不插译文（兜底不变量）。
    // normalizeComparableText 会剥掉 {{N}}，所以纯公式块在这里归一化成空串；
    // 早先写作 `normalizedOriginal && normalizedOriginal === normalizedTranslation`，
    // 空串是 falsy，同一性守卫对纯公式块从不生效，公式因而被重复渲染。
    if (!normalizedOriginal) return true;

    if (normalizedOriginal === normalizedTranslation) {
      return true;
    }

    try {
      if (!settings.skipTargetLanguageText) return false;
      return await isTargetLanguageText(block.text, target.request);
    } catch (error) {
      console.warn('Blab Translation: Language detection failed', error);
      return false;
    }
  }

  // 译文写回页面的唯一入口。三条插入路径（分批回填 / 逐块回退 / 超大块拼回）
  // 全走这里，`accept` 这道迟到校验就不会漏在其中一条上。
  //
  // accept 在 shouldSkipTranslation 之后问：语言判定可能要跑一次 detectLanguage，
  // 把它放在后面意味着「已经作废的请求」还要多花一次判定。但顺序反过来，两者
  // 之间那次 await 又给了页面一个变动的窗口 —— 校验必须是插入前的最后一件事，
  // 这点比省一次本地判定重要。
  async function insertTranslation(
    block, translation, { accept, onSettled, target = passTarget() } = {}
  ) {
    if (await shouldSkipTranslation(block, translation, target)) {
      // 模型把原文原样还回来了 —— 这一块本来就不用翻。这和「翻好了」一样是**终局**，
      // 所以同样要报出去：自动翻译那一层据此记账，不报的话它下一轮还会被送出来，
      // 再花一次同样的钱，永远如此。
      if (onSettled) onSettled(block);
      return;
    }
    if (accept && !accept(block)) return;
    ctx.insertTranslationBlock(block, translation, { lang: target.stamp });
    // 无条件报结果，不去问插入端「真写进去了吗」。它拒收的三种情形都是终局：
    //   · 这一块上已经挂着一条同语言的译文 —— 那就是有结果了；
    //   · 这一轮译成的已经不是用户此刻要的那门语言了（并发的另一轮把页面翻成了
    //     新的），我们是晚到的旧货 —— 重试只会再交一次旧货，而改语言必然伴随
    //     一次重开（调度层 bumpSession 会清空台账、收集端会把旧语言的块放开），
    //     真正该译的那一轮自己会把这一块收走；
    //   · 它是划词/悬停那套的原文壳子 —— 我们永远插不进去，重试只是重复花同
    //     一笔钱。
    // 见 page/insert.js 的 supersedesExistingTranslation。
    if (onSettled) onSettled(block);
  }

  // 分批译文只能按位置回填，回填前数量必须一致 —— 与超大块路径（processOversizedBlock）
  // 同一条规则。模型偶尔会吞掉/多打一个分隔符（把相邻两段合并、或把一段拆成两段），
  // 数量一错开，A 块就会挂上 B 块的译文；行内标记 <a1>…</a1> 还会落进无法还原它的
  // 块里，以字面乱码呈现。数量不一致时退回逐块翻译：一块一请求，单段无从错位，
  // 最坏是某一块拿不到译文而保持原文。
  // target 不传就现读一门：这个函数是导出的（ctx.applyFastBatchTranslations），
  // 从一轮之外进来的调用没有「这一轮的语言」可带。runTranslationPass 一律带。
  async function applyFastBatchTranslations(
    batch, translations,
    { onFailure, isAborted, accept, allowDownload, onSettled, target = passTarget() } = {}
  ) {
    if (!Array.isArray(translations) || translations.length !== batch.length) {
      const returned = Array.isArray(translations) ? translations.length : 0;
      console.warn(
        `Blab Translation: fast-batch returned ${returned} translations for ${batch.length} blocks; ` +
        'retrying block-by-block to avoid misaligned translations'
      );
      await translateBlocksOneByOne(batch, { onFailure, isAborted, accept, allowDownload, onSettled, target });
      return;
    }

    await Promise.all(translations.map(async (translation, i) => {
      if (!batch[i] || !translation) return;
      await insertTranslation(batch[i], translation, { accept, onSettled, target });
    }));
  }

  async function translateBlocksOneByOne(
    batch,
    { onFailure, isAborted, accept, allowDownload = true, onSettled, target = passTarget() } = {}
  ) {
    for (const block of batch) {
      if (isAborted && isAborted()) return;
      try {
        const response = await requestBatch({
          type: 'TRANSLATE_BATCH_FAST',
          texts: [block.text],
          targetLang: target.request,
          delimiter: DELIMITER,
          allowDownload
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
        await insertTranslation(block, translation, { accept, onSettled, target });
      } catch (error) {
        // 扩展上下文失效意味着后面每一块都必然失败，抛给 processBatch 的 catch 统一置 batchError。
        if (isExtensionContextInvalidated(error)) throw error;
        console.error('Blab Translation: Per-block fallback translation failed', error);
        if (onFailure) onFailure(error.message);
      }
    }
  }

  async function filterBlocksByLanguage(blocks) {
    if (!chrome?.i18n?.detectLanguage) return blocks;
    if (!settings.skipTargetLanguageText) return blocks;

    const keep = new Array(blocks.length).fill(true);
    const tasks = blocks.map((block, index) => ({ block, index }));

    await runWithConcurrency(tasks, async ({ block, index }) => {
      try {
        if (await isTargetLanguageText(block.text)) {
          keep[index] = false;
        }
      } catch (error) {
        console.warn('Blab Translation: Language pre-check failed', error);
      }
    }, 8);

    return blocks.filter((_, index) => keep[index]);
  }



  // 一轮翻译：一组块进来，译文落到页面上。返回致命错误的消息，没有就返回 null。
  //
  // 什么时候显示进度、什么时候算“整页翻完了”，都不在这里——页面级的那一份状态
  // 归 content/content-page-translation.js，将来自动翻译的增量轮次并不需要它。
  async function runTranslationPass(blocks, options = {}) {
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    // 迟到校验。手动整页翻译不传 —— 用户点下去到译文回来这段时间里，页面通常
    // 还是那一页，而自动翻译的一轮可能横跨一次路由切换。
    const accept = typeof options.accept === 'function' ? options.accept : null;
    // 「这一块有结果了」。翻好了是结果，模型说「不用翻」也是结果 —— 失败不是。
    // 自动翻译拿它记台账：只有报过的块才不再送第二次（见
    // content/content-auto-translate.js 的 commit）。整页翻译不传，它点一次就结束，
    // 没有下一轮。
    const onSettled = typeof options.onSettled === 'function' ? options.onSettled : null;
    // 语言包是几十 MB 的下载，create() 触发它要求 user activation。整页翻译是
    // 用户点出来的，手势就在那儿；自动翻译这一轮没有，硬触发只会换回一个
    // NotAllowedError，白等一次创建超时再回落。所以它明确传 false，直接走
    // needsDownload 那条回落路 —— 和悬停、字幕这两条同样没有手势的路一致。
    const allowDownload = options.allowDownload !== false;
    // 这一轮的目标语言，只在这里读一次。见 passTarget。
    const target = passTarget();
    const total = blocks.length;
    let done = 0;

    // 优先处理首屏相关内容
    const { priorityBlocks, deferredBlocks } = splitBlocksByViewport(blocks);

    // 按 token/字符数/段落数智能分批
    const priorityBatches = createSmartBatches(priorityBlocks);
    const deferredBatches = createSmartBatches(deferredBlocks);
    // 软优先：首屏批次排在前面，但不阻塞后续批次启动
    const batches = priorityBatches.concat(deferredBatches);
    const concurrency = usingBuiltinEngine() ? CONCURRENCY.builtin : CONCURRENCY.ai;

    console.log(`Blab Translation: ${blocks.length} blocks, ${batches.length} batches, concurrency: ${concurrency}`);


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

    // 「还要不要继续」只有这一个答案。三处要问：超大块的分块循环、每个批次开跑
    // 前、以及传给逐块回退的那个谓词。
    //
    // 外面喊停和里面出错是两回事，但**停法必须是同一个**。自动翻译那一轮可能横跨
    // 一次路由切换或一次改设置 —— 到那时这一页已经不归这一轮管了，`accept` 会把
    // 回填一条条拒掉，可池子里剩下的批次照样一个接一个发出去。并发 12、几百块的
    // 队列，用户关掉自动翻译或换掉付费引擎之后，账单还在涨，而页面上一个字都不会
    // 变 —— 没有任何地方看得出来。
    const aborted = () => !!batchError || (typeof options.isAborted === 'function' && options.isAborted());

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
        if (aborted()) return;
        try {
          const response = await requestBatch({
            type: 'TRANSLATE_BATCH_FAST',
            texts: sb.map(x => x.text),
            targetLang: target.request,
            delimiter: DELIMITER,
            allowDownload
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
          console.error('Blab Translation: Oversized block translation failed', error);
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
      await insertTranslation(block, combined, { accept, onSettled, target });
    };

    // 使用 Promise 池进行并发控制
    const processBatch = async (batch) => {
      // 出错了，或者外面已经不要这一轮的结果了
      if (aborted()) return;
      if (!isExtensionContextAvailable()) {
        batchError = t('extensionContextInvalidated');
        return;
      }

      // 超大块：单独成批，走分块翻译流程
      if (batch.length === 1 && batch[0].oversized) {
        await processOversizedBlock(batch[0]);
        done += batch.length;
        onProgress(done, total);
        return;
      }

      const texts = batch.map(item => item.text);

      try {
        // allowDownload 见 runTranslationPass 开头：用户点出来的那一轮可以触发
        // 语言包首次下载（进度就显示在下方进度条上），自动那一轮不行。
        const response = await requestBatch({
          type: 'TRANSLATE_BATCH_FAST',
          texts: texts,
          targetLang: target.request,
          delimiter: DELIMITER,
          allowDownload
        });

        // Check for error in response
        if (response.error) {
          noteBatchFailure(response.error);
        } else {
          // translations 缺失/非数组的畸形响应也交给守卫：按“数量不一致”处理，
          // 走逐块回退，而不是无声丢掉整批。
          await applyFastBatchTranslations(batch, response.translations, {
            allowDownload,
            onFailure: noteBatchFailure,
            isAborted: aborted,
            accept,
            onSettled,
            target
          });
        }
      } catch (error) {
        console.error('Blab Translation: Batch translation failed', error);
        if (isExtensionContextInvalidated(error)) {
          batchError = t('extensionContextInvalidated');
        } else {
          noteBatchFailure(error.message);
        }
      }

      done += batch.length;
      onProgress(done, total);
    };

    // 并发执行所有批次，首屏批次在队列前优先开始
    if (batches.length > 0) {
      await runWithConcurrency(batches, processBatch, concurrency);
    }

    return batchError;
  }

  ctx.runTranslationPass = runTranslationPass;
  ctx.filterBlocksByLanguage = filterBlocksByLanguage;
  // 单元测试直接驱动这条“译文数量必须与块数一致”的守卫
  // （test/unit/fast-batch-alignment.test.mjs），不必伪造整条整页翻译流水线。
  ctx.applyFastBatchTranslations = applyFastBatchTranslations;
  // 内置翻译引擎撞到输入配额上限时要把长文本切开重试，复用这里的切块器，
  // 它保证不会把 {{n}} 数学占位符从中间切断。
  ctx.splitTextIntoChunks = splitTextIntoChunks;
  // 自动翻译的调度层判「这一页是什么语言」用的也是它 —— 同一个阈值，
  // 同一份清洗（见上面 LANGUAGE_CONFIDENCE_MIN 的注释）。
  ctx.detectReliableLanguage = detectReliableLanguage;
  ctx.PAGE_LIMITS = Object.freeze({ MAX_BLOCK_CHARS, MAX_BATCH_CHARS, MAX_BATCH_ITEMS, MAX_BATCH_TOKENS, CONCURRENCY });
})();
