// Blab Translation 视频字幕 —— 按播放头往前译
//
// 一条轨道不是一次译完的：以播放头为中心开一扇窗，先译观众马上要听到的，再往前填。
// 批次的挑选、发送、失败退避、以及「此刻该显示哪一句」都在这里。
//
// 纯逻辑（切句、合并、分批）在 shared/caption-core.js，这一份是它的调度。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;
  const core = globalThis.CaptionCore;
  if (!core) return;
  // 这一族共用的架子，说明见 content/content-video-captions.js 顶上。
  const caps = (ctx.captions = ctx.captions || {});
  const state = caps.state;

  function getCueKey(cue) {
    return `${caps.getTargetLang()}|${state.trackId}|${cue.startMs}|${cue.text}`;
  }

  function clearTrack() {
    state.rawCues = [];
    state.cues = [];
    state.batches = [];
    state.cueCache.clear();
    state.pendingKeys.clear();
    state.failedUntil.clear();
    state.budgetSpent = false;
  }

  function getActiveCue(nowMs) {
    return state.cues.find((cue) => nowMs >= cue.startMs && nowMs <= cue.endMs);
  }

  // ------------------------------------------------------------ translation

  /**
   * translateCues 的第三种回答。
   *
   * true 这一批译好了；false 这一批没成（已经记了冷却，等下一次触发再来）；STALE
   * 这一批**过期**了——轨道或目标语言换了，它不作数，可这不是失败：新的那一套句子一
   * 个都还没译，而当时想去译它们的那一次调用（ingestTrack 的
   * ensureTrackTranslated(true)，或者换目标语言那一路的 handleTimeUpdate）正好撞
   * 上 state.translating 被这一批占着，什么也没做就回去了。把它当失败停下来，视
   * 频这时候要是停着，就再没有 timeupdate 来推第二次，新字幕会一直空着。
   */
  const STALE = 'stale';

  async function translateCues(cues) {
    if (caps.sameLanguage() || !cues.length) return true;
    if (ctx.isExtensionContextAvailable && !ctx.isExtensionContextAvailable()) return false;

    // 发请求那一刻这批句子的键，和这一轮属于谁。
    //
    // 键必须在这里就取好：getCueKey() 读的是 state **此刻**的值，而 await 之下它
    // 会变——观众在播放器里换一门字幕语言（trackId 变），或者换了目标语言。回来时
    // 照当时的 state 重算一遍键，等于把上一门语言的译文写进新的那一套键里，画面上
    // 会出现上一轮译出来的句子，而且因为键是对的，它永远不会被重译掉。
    //
    // 拿旧键写回是无害的（新的那一套看不见它），拿旧键**放开** pendingKeys 则是
    // 必须的：那一套键就是当初记进去的那一套，不照它删，这几句会永远停在「正在
    // 译」上——isSegmentTranslatable() 认 pendingKeys。
    const keys = cues.map((cue) => getCueKey(cue));
    // 记「正在译」和放开它是同一件事的两头，所以两头都在这个函数里：调用方记、
    // 这里放，上面那两道 return 就是两个放不掉的口子。
    keys.forEach((key) => state.pendingKeys.add(key));
    const trackId = state.trackId;
    // 「这一批说的还是不是同一回事」，一共就两样：哪条轨道，往哪门语言译。
    //
    // 这里曾经比的是整页那一面的代次号（autoTranslate 的 sessionVersion）。那是
    // 另一个部件的时钟：用户在 popup 上暂停这一页、把译文藏起来、关掉全局自动翻
    // 译，它都会翻篇——而字幕的轨道、目标语言、引擎一样没变。在飞的那一批因此被
    // 判成过期丢掉，下一轮 pickNextBatch 又把同一批没缓存的句子挑出来重发一次：
    // 白白付两回钱，而第一回的结果就在手上。
    const target = caps.getTargetLang();

    const texts = cues.map((cue) => cue.text);
    let response;
    let threw = false;
    try {
      // 走缓存层（content/content-translation-cache.js）：它与 ctx.requestTranslation
      // 同形，只是先去缓存里看一眼。**同一部片重看一遍不该再付一次钱** —— 内存里
      // 那张 state.cueCache 只活到 clearTrack()，换一集、刷一次页面就空了，而一部
      // 两小时的片子是两千来条句子。没加载到它就走原路（单元测试只装 captions/*）。
      response = await (ctx.requestTranslationCached || ctx.requestTranslation)(core.buildTranslationRequest({
        texts,
        targetLang: ctx.getEffectiveTargetLang ? ctx.getEffectiveTargetLang() : '',
        trackLang: state.trackLang,
        delimiter: caps.DELIMITER,
      }));
    } catch (error) {
      threw = true;
    }

    // 轨道换了，或者目标语言换了：这一批说的是另一回事了，丢掉——**不管它是成是
    // 败**。
    // 所以这一问排在看 response 之前：请求失败和世界变了是两件独立的事，一批过期
    // 的请求恰好也报了错（换目标语言时在飞的那一个多半如此），按失败处理就是记一
    // 笔谁也用不上的冷却、然后 return false 把整轮停在那里（见 STALE）。
    //
    // 丢之前要先按当初那一套键把 pendingKeys 放开。换轨道那一路 clearTrack() 确实
    // 已经连表带键清过一遍，换目标语言那一路却没有——applyCaptionSettings() 只重新
    // 渲染和重新调度，不碰这张表。不放开的话，这几句就卡在「正在译」上：既不重试
    // 也不显示，而且是**永远**，因为再没有谁会去动它们。
    if (trackId !== state.trackId || target !== caps.getTargetLang()) {
      releaseBatch(keys);
      return STALE;
    }

    if (threw) {
      markBatchFailed(keys);
      return false;
    }

    if (!response || response.error || !Array.isArray(response.translations)) {
      // 额度用完和别的失败走同一条冷却：隔几秒再试一次不花钱（闸在发出去之前
      // 就拒了），而额度调高或者过了零点之后，正是这一次重试把字幕接回来。
      state.budgetSpent = !!(response && response.budgetSpent);
      markBatchFailed(keys);
      return false;
    }

    // 条数对不上就整批作废。上游两条路径今天都保证条数相等（AI 那条段数不等时自己
    // 退回编号法，内置那条逐条 push），所以这不是在修一个线上 bug——它防的是下标错
    // 位：短一条，尾部那几句会一直留在 pendingKeys 里，既不重试也不显示，而且
    // isSegmentTranslatable() 认 pendingKeys，它们从此对任何一轮都是「已经在译了」。
    if (response.translations.length !== cues.length) {
      markBatchFailed(keys);
      return false;
    }

    state.budgetSpent = false;
    response.translations.forEach((translation, index) => {
      const cue = cues[index];
      if (!cue) return;
      const key = keys[index];
      state.cueCache.set(key, translation || cue.text);
      state.pendingKeys.delete(key);
      state.failedUntil.delete(key);
    });

    renderActiveCue(state.lastNowMs);
    return true;
  }

  /** 这一批没失败，只是过期了：不记冷却，只把「正在译」这个标记还回去。 */
  function releaseBatch(keys) {
    keys.forEach((key) => state.pendingKeys.delete(key));
  }

  // 键由调用方在发请求那一刻取好（见 translateCues）。
  //
  // 这里不再自己对一次 trackId：唯一的调用方在此之前已经答过「脚下的世界变了没
  // 有」，变了的那一批走的是 STALE 那条路，根本到不了这里。同一个问题留两个答案，
  // 迟早有一天它们说的不是一回事。
  function markBatchFailed(keys) {
    releaseBatch(keys);
    const retryAt = Date.now() + caps.RETRY_COOLDOWN_MS;
    keys.forEach((key) => state.failedUntil.set(key, retryAt));
  }

  function isSegmentTranslatable(seg, wallNow) {
    const key = getCueKey(seg);
    if (state.cueCache.has(key) || state.pendingKeys.has(key)) return false;
    const retryAt = state.failedUntil.get(key);
    return !(retryAt && retryAt > wallNow);
  }

  /**
   * 这一句离播放头多远（毫秒），正在播的那一句是 0。
   *
   * 量的是**句子**，不是批次。批次只按条数和字数切（buildBatches），时间上想多长
   * 有多长：一段前面一句、一小时后一句的稀疏轨道，两句会落在同一批里，而这一批
   * 「离播放头最近的那一头」是 0 —— 按批次量距离，那一小时之外的一句就跟着进来
   * 了，窗等于没设。
   */
  function segmentDistance(seg, playheadMs) {
    if (playheadMs < seg.startMs) return seg.startMs - playheadMs;
    if (playheadMs > seg.endMs) return playheadMs - seg.endMs;
    return 0;
  }

  /**
   * 这一句在不在窗里。
   *
   * 窗是**花钱的闸**，不是「译哪一段」的规矩。所以不设窗的时候（内置引擎，而且不
   * 会回退到付费那条路）整条轨道都在窗里，播放头后面那些也算——加窗之前本来就是
   * 整条译到底，那一路一分钱不花，没有理由缩。
   *
   * 设了窗就只往前看。距离本身是对称的（seg 在播放头前后都算得出来），可拿它直接
   * 比上限，等于让播放头后面五分钟的句子和前面五分钟的句子抢同一份额度：实际宽度
   * 翻了一倍，而多出来的那一半全花在观众已经跳过去的内容上。倒回去看是另一回事
   * ——那时播放头自己就退回来了，这些句子重新排在它前面。
   */
  function withinWindow(seg, playheadMs, limitMs) {
    if (limitMs === Infinity) return true;
    if (seg.endMs < playheadMs) return false;
    return segmentDistance(seg, playheadMs) <= limitMs;
  }

  /**
   * 这一轮往前译多远（毫秒），Infinity = 不设限。
   *
   * 只有花钱的那条路需要设限。内置引擎是本机跑的，不联网、不计费，整条轨道一次
   * 译完的代价只是几十毫秒 CPU——给它设窗反而会让观众往回拖进度条时重译。
   *
   * 但**「选了内置引擎」不等于「这一批不花钱」**。isActive() 答的是「内置是选中
   * 的那个引擎，而且这个环境给得了」，它答不了「这门语言对此刻真能在本机跑」：
   * 语言包还没下到本地时 handleWithBuiltin() 抛 EngineUnavailableError，而
   * engineFallback === 'allow-ai' 的用户会把这一批原样转给他自己的接口（见
   * content-translation-engine.js 的 requestTranslation）。于是一场两小时的讲座
   * 在他看到第二句之前就整片发去了云端——正是这个窗存在的理由。
   *
   * 所以不设限的条件多一条：回退关着。那时内置跑不起来就是报错，一个字也不会发
   * 出去，Infinity 确实不花钱。反过来，回退开着而包其实就在本地，会白设一个窗，
   * 代价只是译文晚一点点到（本机译本来就快）——比前一种便宜得多。
   */
  function translationWindowMs() {
    const builtin = ctx.builtinTranslator;
    const free = builtin && builtin.isActive && builtin.isActive()
      && caps.getSetting('engineFallback') !== 'allow-ai';
    if (free) return Infinity;
    return caps.currentDisplay().useNative ? caps.NATIVE_WINDOW_MS : caps.WINDOW_MS;
  }

  // Pick the batch nearest the playhead that still has translatable segments, so
  // what the viewer is watching translates first while the rest fills in ahead
  // of him. Batches past `limitMs` from the playhead are left for later: the
  // window slides as he watches, and a seek re-centres it on the next trigger.
  function pickNextBatch(limitMs) {
    const wallNow = Date.now();
    const playhead = state.lastNowMs;
    let best = null;
    let bestDist = Infinity;
    for (const batch of state.batches) {
      // 窗按句子量，不按批次量（见 withinWindow）。一批里窗内窗外都有是常事，
      // 只把窗内那几句挑出来发；剩下的等窗滑过去再说，下一次触发自然会取到。
      let dist = Infinity;
      const todo = [];
      for (const seg of batch) {
        if (!withinWindow(seg, playhead, limitMs)) continue;
        const segDist = segmentDistance(seg, playhead);
        if (!isSegmentTranslatable(seg, wallNow)) continue;
        todo.push(seg);
        if (segDist < dist) dist = segDist;
      }
      if (!todo.length) continue;
      if (dist >= bestDist) continue;
      bestDist = dist;
      best = todo;
    }
    return best;
  }

  // Translate ahead of the playhead, nearest first. Safe to call often: it
  // no-ops while a pass runs and briefly after a failed batch, and it stops at
  // the window's edge rather than at the end of the track — handleTimeUpdate
  // calls it again as the playhead advances, which is what moves the window.
  // 每一轮的号。state.translating 存的是**此刻这一轮是谁**，不只是「有人在跑」。
  let passSeq = 0;

  async function ensureTrackTranslated(force) {
    if (caps.sameLanguage() || state.dismissed || state.translating) return;
    const now = Date.now();
    if (!force && now - state.lastTriggerMs < 2000) return;
    state.lastTriggerMs = now;
    // 拿号，而不是举一面「有人在跑」的旗子。这一轮的所有权是**会被收走的**：
    // resetForVideo() 把 state.translating 清掉（换视频、SPA 跳转），紧接着新轨道
    // 进来，ingestTrack() 又起一轮新的——而旧那一轮此刻正停在 await 上。它回来时
    // 只要照 STALE 那条路接着跑，两轮就并排跑起来了，而且各自的 finally 都会把标
    // 志清掉，于是第三轮第四轮也能进来：付费的批次同时在飞，串行那条规矩就等于没
    // 有。号对不上，这一轮就是已经不算数的那一轮。
    const pass = ++passSeq;
    state.translating = pass;
    try {
      while (state.active && !caps.sameLanguage() && !state.dismissed) {
        // 窗每一轮现算。一轮可以跑很久，而这中间观众可以把引擎从内置换成 AI ——
        // 取一次留着用，等于拿「上一个引擎不花钱」这个结论去放行下一个引擎的批次。
        const batch = pickNextBatch(translationWindowMs());
        if (!batch || !batch.length) break;
        const result = await translateCues(batch);
        // 所有权在 await 那一头被收走了：接班的那一轮已经在跑新的一套，这里再往
        // 下走就是两轮并行。走人，而且什么都别碰。
        if (state.translating !== pass) return;
        // 过期不是失败：这一批不作数，可新世界里那些句子还等着，而想去译它们的那
        // 次调用早被 state.translating 挡回去了（见 STALE）。接着往下走——下一轮
        // pickNextBatch 取的已经是新的那一套。换目标语言走的正是这一路：没人动过
        // 所有权，所以接着跑的还是这一轮。
        if (result === STALE) continue;
        if (!result) break; // cooldown set on the batch; a later trigger resumes it
      }
    } finally {
      // 只清自己那一号。清掉别人的，等于替下一次调用把门打开，而接班那一轮还在跑。
      if (state.translating === pass) state.translating = false;
    }
  }

  function renderActiveCue(nowMs) {
    if (!state.overlay) return;
    const cue = getActiveCue(nowMs);
    if (!cue) {
      caps.setOverlayContent('', '');
      return;
    }
    // Original shows immediately; the translated line fills in once it is ready.
    caps.setOverlayContent(cue.text, state.cueCache.get(getCueKey(cue)) || '');
  }

  // --------------------------------------------------------------- playback

  // 别的文件要用的，都从这张架子上取。
  Object.assign(caps, {
    clearTrack, ensureTrackTranslated, renderActiveCue,
  });
})();
