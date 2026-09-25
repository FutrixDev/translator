// Blab Translation — 译文的两级缓存。
//
// 手动翻译是「用户点一下，翻一页」，重复请求少到不值得记账。自动翻译不是：
// 信息流里同一条推文出现在时间线、详情页和转推引用里，回访一篇文章又从头来一遍，
// 而每一次重复都是一次真实的 API 调用。没有缓存，自动模式在 AI 引擎下的花费
// 不可控 —— 这个模块存在的全部理由就是这句话。
//
// **只缓存 AI 引擎的结果。** 内置引擎（Chrome 端上的 Translator）零网络、零费用，
// 把它的译文也塞进来，省下的是几十毫秒，花掉的是用户 chrome.storage.local 那
// 10 MB 配额里的一大块（本扩展没申请 unlimitedStorage，PDF 任务和漫画令牌也住在
// 同一块地方）。顺带省掉了一个真问题：内置引擎的源语言是按**页面语言**推断出来
// 的，同一段英文出现在法语页面和英语页面上，译出来可以不一样 —— 而推断出来的那
// 个值不在请求里，键因子看不见它，跨页复用就会串味。（请求里**声明**的源语言是
// 另一回事，它看得见，见下面的 sourceLang。）
//
// 键里有七个因子，少一个都会在某个时刻无声地供应错误的译文：
//
//   text        —— 原样，不做归一化。缓存的是「这一串字符换来的那个回答」，
//                  折叠空白能提高命中率，但也就把两串不同的输入并成了一个答案。
//   targetLang  —— 显然。
//   sourceLang  —— 请求里声明的源语言。整页翻译从不声明（引擎自己去认），字幕
//                  声明：一条字幕轨道自己说得出它是哪门语言，而一句台词短到测不
//                  出来（见 shared/caption-core.js 的 buildTranslationRequest）。
//                  同一句 "Yes." 来自英语轨和来自法语轨是两件事。服务工作者今天
//                  那条 AI 路径还不读这个字段，但键不该押在别人此刻的实现细节
//                  上 —— 哪天它开始读了，缓存会一声不响地继续按旧口径供货。
//   endpoint    —— 同名模型挂在不同网关（OpenAI / OpenRouter / 本地 Ollama）后面
//                  是两个东西。
//   model       —— 显然。
//   prompt      —— 用户自定义提示词。换了提示词，旧键会继续按旧口径供货，
//                  而且没有任何征兆。
//   version     —— 扩展版本号，代内置提示词（background.js 的 DEFAULT_BATCH_PROMPT
//                  那一套）。**刻意不用手工维护的 PROMPT_VERSION 常量**：那种常量的
//                  寿命等于「下一个改提示词的人记得同步 +1」，而版本号在每次发版时
//                  自动就变了，忘不掉。代价是每次更新扩展作废一次缓存 —— 条目本来
//                  也只活 30 天，一次重译而已。
//
// apiKey 不在键里，也永远不该在：它不改变译文，而键会以明文落进 storage。
//
// 落盘用一条目一个 key（`tc:<hash>`），不是一个大对象。整块对象每写一次就要把
// 全部条目重新序列化一遍，而整页翻译是几十次连续写入。
(function (root) {
  'use strict';

  const KEY_PREFIX = 'tc:';
  // 「缓存被清空了」的广播信号。**刻意不带 tc: 前缀**：它不是一条译文，而
  // sweep 的过期清理和 clear 自己的批量删除都是按前缀取键的，带上前缀就会把
  // 信号本身一起删掉。
  const EPOCH_KEY = 'translationCacheEpoch';
  // 因子之间的分隔符取 U+0000：用户自定义提示词是唯一有可能塞进任意字符的因子，
  // 而它来自 <textarea>，里面出现真正的 NUL 需要刻意构造。有了它，
  // ('ab', 'c') 和 ('a', 'bc') 不会撞成同一个键。
  // 源码里写转义而不是那个字节本身：一个真的 NUL 会让 git 把整份文件判成二进制，
  // 此后它在任何 diff 里都只剩一行 `Bin ... bytes`，评审和 blame 一起失效。
  const SEP = '\u0000';
  const TTL_MS = 30 * 24 * 60 * 60 * 1000;
  // L1 是本页进程内的，上限按条数；一条译文几百字节，2000 条是几百 KB。
  const L1_LIMIT = 2000;
  // L2 的预算按**字节**而不是条数：段落长度能差一个数量级，条数是个很差的代理。
  // 4 MB 是 10 MB 配额里留给缓存的那一份，剩下的归 PDF 任务、令牌和设置。
  const BYTE_BUDGET = 4 * 1024 * 1024;
  const EVICT_FRACTION = 0.25;
  // 写入攒一下再落盘：整页翻译会在几秒内产生几十次写。
  const FLUSH_DELAY_MS = 500;

  const FNV_PRIME = 0x01000193;

  // 进程内 L1，插入序即 LRU（命中时删了重插）。
  const l1 = new Map();
  // 等待合并落盘的写入。
  const pendingWrites = new Map();
  // 正在路上的请求：key -> Promise<string|undefined>。同一段文字被两个并发批次
  // 同时要到时，只发一次。
  const inflight = new Map();

  let flushTimer = null;

  /**
   * FNV-1a，两条不同起点的 32 位 lane 拼成 16 位十六进制。
   *
   * 这里**必须**比 shared/block-identity.js 那个 32 位的宽：那边的比较永远发生在
   * 同一个元素的新旧两段文字之间，是 1/2^32 的单次碰撞；这里是几千上万条键互比，
   * 是生日问题 —— 20000 条键在 32 位空间里撞上的概率约 4.7%，而一次碰撞的后果是
   * 某一段被神不知鬼不觉地换成另一段的译文。64 位把它压到 1e-11。
   */
  function hash(text) {
    const value = text == null ? '' : String(text);
    let a = 0x811c9dc5;
    let b = 0x7f8c9e2b;
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      a = Math.imul(a ^ c, FNV_PRIME);
      b = Math.imul(b ^ c, FNV_PRIME);
      // 两条 lane 同数据同乘子，只差起点，走着走着会趋同；每步给 b 一个不同的
      // 扰动（右移异或）才真的是两份独立的证据。
      b ^= b >>> 7;
    }
    return ((a >>> 0).toString(16).padStart(8, '0')) + ((b >>> 0).toString(16).padStart(8, '0'));
  }

  // 因子顺序是键的一部分，别调整，调整了等于清空所有人的缓存。
  const FACTORS = ['text', 'targetLang', 'sourceLang', 'endpoint', 'model', 'prompt', 'version'];

  function buildKey(factors) {
    return KEY_PREFIX + hash(FACTORS.map((name) => {
      const value = factors[name];
      return value == null ? '' : String(value);
    }).join(SEP));
  }

  function rememberL1(key, translation) {
    if (l1.has(key)) l1.delete(key);
    l1.set(key, translation);
    while (l1.size > L1_LIMIT) l1.delete(l1.keys().next().value);
  }

  /**
   * 把这个上下文里攒着的一切丢掉 —— 定时器、待写、L1。
   *
   * 清空缓存有两半。落盘的那一半只有一处（chrome.storage.local），删一次就没了；
   * 内存里的这一半**每个上下文各有一份** —— 设置页一份、每个开着的标签页一份、
   * service worker 一份，它们是同一份源码的不同实例，互相看不见。所以删完落盘的
   * 那一半还不算清空：那些标签页会继续按自己的 L1 供货，而它们那 500 ms 里攒着
   * 的条目会在删除**之后**落回 storage，用户按下「清除」，缓存却自己长了回来。
   */
  function dropLocalState() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    pendingWrites.clear();
    l1.clear();
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush().catch((error) => {
        console.warn('Blab Translation: translation cache flush failed', error);
      });
    }, FLUSH_DELAY_MS);
  }

  async function flush() {
    if (pendingWrites.size === 0) return;
    const batch = {};
    const now = Date.now();
    for (const [key, translation] of pendingWrites) batch[key] = { t: translation, ts: now };
    pendingWrites.clear();
    await chrome.storage.local.set(batch);
  }

  /** 读 L2 里这一批键，顺手滤掉过期的。存储读不到（配额、上下文失效）就当全未命中。 */
  async function readL2(keys) {
    if (keys.length === 0) return new Map();
    let stored;
    try {
      stored = await chrome.storage.local.get(keys);
    } catch (error) {
      console.warn('Blab Translation: translation cache read failed', error);
      return new Map();
    }
    const found = new Map();
    const cutoff = Date.now() - TTL_MS;
    for (const key of keys) {
      const entry = stored[key];
      if (!entry || typeof entry.t !== 'string') continue;
      if (!(entry.ts > cutoff)) continue;
      found.set(key, entry.t);
    }
    return found;
  }

  /**
   * 一批文本进来，等长的一批译文出去 —— 中间能不发的都不发。
   *
   * 顺序和长度是这个函数唯一不能出错的地方：上游（content/page/batch.js）按位置
   * 回填译文，多一条少一条都会让 A 块挂上 B 块的译文。所以未命中的那些被抽出去
   * 单独成一批发走，回来再按原位置塞回去，而不是把整批打散重排。
   *
   * @param {string[]} texts
   * @param {object} factors 除 text 之外的键因子（targetLang / sourceLang / endpoint / model / prompt / version）
   * @param {(missing: string[]) => Promise<string[]|null>} fetchMissing
   *        只会收到**去重后**的未命中文本，必须返回等长数组；返回 null 表示这批失败了。
   * @returns {Promise<string[]|null>} 与 texts 等长；fetchMissing 失败时原样返回 null
   */
  async function serve(texts, factors, fetchMissing) {
    followClears();
    const keys = texts.map((text) => buildKey({ ...factors, text }));
    // 本次调用自己的账本。**刻意不拿 L1 当账本**：L1 有容量上限，一次足够大的
    // 调用能把自己早先放进去的条目挤出去，回填时就成了一个空洞 —— 而空洞在
    // 上游就是「A 块挂上 B 块的译文」。
    const resolved = new Map();
    // 同一段文字在一批里出现多次（重复的段落、转推引用）只算一份。
    const pending = new Map(); // key -> 第一次出现的 text
    for (let i = 0; i < texts.length; i++) {
      const cached = l1.get(keys[i]);
      if (cached !== undefined) {
        rememberL1(keys[i], cached);
        resolved.set(keys[i], cached);
      } else if (!pending.has(keys[i])) {
        pending.set(keys[i], texts[i]);
      }
    }

    if (pending.size > 0) {
      const found = await readL2([...pending.keys()]);
      for (const [key, translation] of found) {
        rememberL1(key, translation);
        resolved.set(key, translation);
        pending.delete(key);
      }
    }

    // 别人正在要的，等它一下，别再发一遍。等来 undefined 说明那一批失败了，
    // 这一段就落回下面自己去要。
    const waited = [...pending.keys()].filter((key) => inflight.has(key));
    if (waited.length > 0) {
      await Promise.all(waited.map(async (key) => {
        const translation = await inflight.get(key);
        if (typeof translation === 'string') {
          rememberL1(key, translation);
          resolved.set(key, translation);
          pending.delete(key);
        }
      }));
    }

    if (pending.size > 0) {
      const missingKeys = [...pending.keys()];
      const missingTexts = missingKeys.map((key) => pending.get(key));
      // 先挂上 in-flight 再 await：并发批次要能在这一批回来之前就看见它。
      const settlers = missingKeys.map((key) => {
        let settle;
        inflight.set(key, new Promise((resolve) => { settle = resolve; }));
        return settle;
      });
      let translations = null;
      let usable = false;
      try {
        translations = await fetchMissing(missingTexts);
      } finally {
        // 数量对不上就整批当失败：这里不做任何对齐猜测，上游有它自己的退路
        // （逐块重译），猜错的代价是译文错位。
        usable = Array.isArray(translations) && translations.length === missingKeys.length;
        missingKeys.forEach((key, i) => {
          const translation = usable ? translations[i] : undefined;
          if (typeof translation === 'string') {
            resolved.set(key, translation);
            // 空串是「这一段没译出来」，不是一个答案：原样传回去让上游保留原文，
            // 但绝不记住它，否则这一段就永远是空的了。
            if (translation) {
              rememberL1(key, translation);
              pendingWrites.set(key, translation);
            }
          }
          inflight.delete(key);
          settlers[i](typeof translation === 'string' ? translation : undefined);
        });
        if (usable) scheduleFlush();
      }
      if (!usable) return null;
    }

    return keys.map((key) => resolved.get(key));
  }

  /**
   * 过期清理 + 字节预算。由 background 的 chrome.alarms 每天叫一次。
   *
   * 先按时间扔，再看总量：30 天是「这条译文还作数吗」，字节预算是「这个扩展在
   * 用户的配额里占多大」，两件事，都要。
   */
  async function sweep() {
    let all;
    try {
      all = await chrome.storage.local.get(null);
    } catch (error) {
      console.warn('Blab Translation: translation cache sweep failed', error);
      return { removed: 0, kept: 0 };
    }
    const cutoff = Date.now() - TTL_MS;
    const doomed = [];
    const alive = [];
    for (const [key, entry] of Object.entries(all)) {
      if (!key.startsWith(KEY_PREFIX)) continue;
      // 形状不对的条目（旧写法、被别的代码踩过）一并扔掉：留着也读不出来。
      if (!entry || typeof entry.t !== 'string' || !(entry.ts > cutoff)) doomed.push(key);
      else alive.push({ key, ts: entry.ts });
    }

    let evicted = 0;
    if (alive.length > 0) {
      let bytes = 0;
      try {
        bytes = await chrome.storage.local.getBytesInUse(alive.map((e) => e.key));
      } catch (error) {
        // getBytesInUse 拿不到就只做过期清理，不瞎猜大小。
        bytes = 0;
      }
      if (bytes > BYTE_BUDGET) {
        // 超了就一次扔掉四分之一最旧的，而不是刚好扔到预算线上：踩着线清理，
        // 下一次翻译立刻又超，于是每天的清理都在原地打转。
        alive.sort((a, b) => a.ts - b.ts);
        evicted = Math.min(alive.length, Math.ceil(alive.length * EVICT_FRACTION));
        for (let i = 0; i < evicted; i++) doomed.push(alive[i].key);
      }
    }

    if (doomed.length > 0) {
      try {
        await chrome.storage.local.remove(doomed);
      } catch (error) {
        console.warn('Blab Translation: translation cache eviction failed', error);
        return { removed: 0, kept: alive.length };
      }
      for (const key of doomed) l1.delete(key);
    }
    return { removed: doomed.length, kept: alive.length - evicted };
  }

  /**
   * 清空缓存 —— 设置页那颗按钮走的就是这里。
   *
   * 隐私政策的「删除你的数据」一节把缓存和设置、站点规则、统计并列，所以它必须
   * 真的有一条能按的路；没有这个函数，那一句就只能改成「卸载扩展」。
   *
   * 三步，缺一步就还有译文活着：丢掉本上下文攒的（dropLocalState），删掉落盘的，
   * 然后**告诉别的上下文也丢**。最后那一步不是锦上添花 —— 一个开着的标签页有
   * 自己的 L1 和自己的待写队列，删 storage 碰不到它们。
   */
  async function clear() {
    dropLocalState();

    // 这里**不吞错误**，而 sweep 吞 —— 两者的区别是有没有人在等答案。sweep 由
    // chrome.alarms 半夜叫起来，没清成就下次再说；clear 是有人刚按下按钮，按了
    // 没反应就是「说好能删，其实删不掉」。所以失败往上抛，让设置页说出来。
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((key) => key.startsWith(KEY_PREFIX));
    if (keys.length > 0) await chrome.storage.local.remove(keys);

    // 广播。写什么无所谓，**变了**就行，所以必须每次都不一样：同一毫秒里连按两次
    // 「清除」，光一个 Date.now() 会写回同一个值，onChanged 也就不发了。
    // 放在删除之后：先广播的话，标签页可能在 remove 落地之前就丢完并重新读回
    // 几条还没删掉的。
    await chrome.storage.local.set({
      [EPOCH_KEY]: `${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
    });
    return { removed: keys.length };
  }

  // 别人清空了缓存，这边跟着丢。
  //
  // 信号走 storage，是因为 storage 是这几个上下文之间唯一共有的东西（设置页不能
  // 给标签页发消息，也不该为这一件事去申请 tabs 权限）。**只广播一个时间戳，不
  // 广播被删掉的那几千个键**：后者的 onChanged payload 里带着每一条译文的原文，
  // 一次清空就要往每个开着的标签页塞几兆字节。
  //
  // 正在路上的请求（inflight）不受影响，这是对的：它们是清空**之后**才会回来的
  // 新译文，本来就该留下。这里丢的只有清空之前就已经攒下的东西。
  //
  // 惰性挂：第一次 serve() 时才挂。要丢的东西只有 serve() 攒得出来，没供过货的
  // 上下文没什么可丢；而这个文件也进 dormant frame（广告、支付……，见
  // shared/frame-eligibility.js），那里加载时挂监听就不叫 dormant 了。
  let followingClears = false;
  function followClears() {
    if (followingClears) return;
    followingClears = true;
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && EPOCH_KEY in changes) dropLocalState();
      });
    } catch (error) {
      // 拿不到 onChanged（受限上下文、测试替身）就只是少了这层加固，缓存本身照常
      // 工作，所以不抛。
      console.warn('Blab Translation: translation cache clear broadcast unavailable', error);
    }
  }

  root.TranslationCache = {
    TTL_MS,
    buildKey,
    serve,
    flush,
    sweep,
    clear,
  };
})(globalThis);
