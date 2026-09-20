// 本机统计：这台电脑上，自动翻译到底做了多少事。
//
// 四个数，一个月一清：自动翻过几页、译文缓存替你挡下了多少次请求、有多少字符
// 真的发给了模型。**只落在 chrome.storage.local，不进 sync，一个字节都不出这台
// 机器** —— 它是给用户自己看的一面镜子（设置页那块「本机统计」），不是给我们
// 看的埋点。放 local 而不是 sync 正是为了这句话能站得住：sync 跟着账号走，统计
// 不该跟着走。
//
// 和 shared/site-rules.js 那两张表一样，写入点收进服务工作者：读—改—写只能有
// 一个主人。统计比规则更容易撞 —— 每个标签页都在往里记，而且记得很密。两个
// 标签页同时读到同一份旧数字，后写的那份把先写的盖掉，丢的不是用户的选择，
// 只是几个计数，但丢法是一样的：悄无声息，而且越忙丢得越多。
//
// 纯函数（currentMonth / mergeDelta / messageChars / cacheHitRate）放在最上面，
// node --test 里直接跑，不需要 chrome。
(function (root) {
  'use strict';

  const STORAGE_KEY = 'autoStats';

  // 四个都是单调累加的计数。命中率不在里面，因为**比率没法累加**：这个月前半
  // 段 50%、后半段 80%，两个数字加起来没有任何意义。存两个计数、要用的时候现
  // 除，是这件事唯一不会算错的做法。
  const FIELDS = Object.freeze(['pages', 'aiChars', 'cacheHits', 'cacheMisses']);

  function emptyStats(month) {
    return { month: month || '', pages: 0, aiChars: 0, cacheHits: 0, cacheMisses: 0 };
  }

  /**
   * `'YYYY-MM'`，按**本地**时区。
   *
   * 统计是说给用户听的「这个月」，他看的是自己墙上那本日历，不是 UTC。
   */
  function currentMonth(now) {
    const date = now instanceof Date ? now : new Date();
    const month = date.getMonth() + 1;
    return `${date.getFullYear()}-${month < 10 ? '0' : ''}${month}`;
  }

  // 存进去的东西不一定是我们上次写的：用户可能手动改过，旧版本可能写过别的形状。
  // 一个不是正数的值就当零，别让一个 NaN 顺着加法传染整份统计 —— NaN 加什么都是
  // NaN，一旦进去，这个月剩下的日子里每个数字都是「—」。
  function count(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }

  /**
   * 把一笔增量并进一份统计。纯函数：给什么算什么，不碰存储。
   *
   * 跨月就从零开始 —— 月份对不上时旧数字整份丢掉，而不是接着加。所以这个函数
   * 也是「读出来」时的归一化：传一笔空增量进去，拿回的就是这个月该显示的样子。
   *
   * @param {Object|null} stats 存里那份（可能是别的月份，也可能是畸形的）
   * @param {Object|null} delta 这一笔增量
   * @param {string} month 现在是哪个月
   */
  function mergeDelta(stats, delta, month) {
    const base = stats && stats.month === month ? stats : null;
    const next = emptyStats(month);
    for (const field of FIELDS) {
      next[field] = count(base && base[field]) + count(delta && delta[field]);
    }
    return next;
  }

  /**
   * 这条消息要发出去多少字符。
   *
   * 数的是**源文本**，不是请求体：请求体里还有提示词、JSON 转义、OCR 那条路上
   * 还有一整张 base64 图片，把它们算进「翻译了多少字」只会让这个数字失去意义。
   * 三种翻译消息之外的一概是 0 —— 这个函数就是靠这个来认出「这是一次翻译请求」。
   */
  function messageChars(message) {
    if (!message) return 0;
    if (message.type === 'TRANSLATE') {
      return typeof message.text === 'string' ? message.text.length : 0;
    }
    if (message.type !== 'TRANSLATE_BATCH' && message.type !== 'TRANSLATE_BATCH_FAST') return 0;
    if (!Array.isArray(message.texts)) return 0;
    let total = 0;
    for (const text of message.texts) {
      if (typeof text === 'string') total += text.length;
    }
    return total;
  }

  /**
   * 缓存命中率，0–1。一次都没量过时是 `null`，不是 0 —— 「还没有数据」和
   * 「一次都没命中」是两句不同的话，把前者显示成 0% 是在冤枉缓存。
   */
  function cacheHitRate(stats) {
    const hits = count(stats && stats.cacheHits);
    const total = hits + count(stats && stats.cacheMisses);
    return total > 0 ? hits / total : null;
  }

  // -------------------------------------------------------------- 存储

  function storage() {
    return root.chrome && root.chrome.storage && root.chrome.storage.local;
  }

  /**
   * 这个月的统计。读不到存储（单元测试、没有权限）就给一份空的 —— 统计读不出来
   * 不该让设置页整页报错。
   */
  function read(now) {
    const month = currentMonth(now);
    const store = storage();
    if (!store) return Promise.resolve(emptyStats(month));
    return store
      .get({ [STORAGE_KEY]: null })
      .then((stored) => mergeDelta(stored && stored[STORAGE_KEY], null, month))
      .catch(() => emptyStats(month));
  }

  const IN_SERVICE_WORKER =
    typeof ServiceWorkerGlobalScope !== 'undefined' && root instanceof ServiceWorkerGlobalScope;

  // 只保证顺序，不传播失败：一次写崩了不该把后面的全卡死（同 site-rules.js）。
  let writeQueue = Promise.resolve();

  function enqueue(run) {
    const result = writeQueue.then(run, run);
    writeQueue = result.catch(() => {});
    return result;
  }

  async function applyAdd(message) {
    const store = storage();
    if (!store) return null;
    const month = currentMonth();
    const stored = await store.get({ [STORAGE_KEY]: null });
    const next = mergeDelta(stored && stored[STORAGE_KEY], message.delta, month);
    await store.set({ [STORAGE_KEY]: next });
    return next;
  }

  async function applyReset() {
    const store = storage();
    if (!store) return null;
    const next = emptyStats(currentMonth());
    await store.set({ [STORAGE_KEY]: next });
    return next;
  }

  const WRITES = { add: applyAdd, reset: applyReset };

  /**
   * 服务工作者的入口：把一条写入请求排进队列。背景页的消息分发只管转接
   * （background.js 的 `AUTO_STATS_WRITE`）。
   */
  function applyWrite(message) {
    const write = message && WRITES[message.kind];
    if (!write) return Promise.reject(new Error(`unknown auto-stats write: ${message && message.kind}`));
    return enqueue(() => write(message));
  }

  // 在服务工作者里就自己写，在别处就把这件事交给它 —— 调用方两边共用一个名字。
  function request(kind, payload) {
    const message = Object.assign({ type: 'AUTO_STATS_WRITE', kind }, payload);
    if (IN_SERVICE_WORKER) return applyWrite(message);
    if (!root.chrome || !root.chrome.runtime || !root.chrome.runtime.sendMessage) {
      return Promise.resolve(null);
    }
    // 统计记不上不是错误，别让它把调用方那条正事的错误处理占了。内容脚本在
    // 页面卸载、扩展刚更新完的那一瞬 sendMessage 本来就会抛。
    return root.chrome.runtime
      .sendMessage(message)
      .then((reply) => (reply && reply.value) || null)
      .catch(() => null);
  }

  /**
   * 记一笔。`delta` 里给哪几个键就加哪几个：
   * `{ pages, aiChars, cacheHits, cacheMisses }`。
   */
  function add(delta) {
    return request('add', { delta });
  }

  // 用户在设置页按下「清除」。清的是这台电脑上的这一份，别处没有第二份。
  function reset() {
    return request('reset');
  }

  root.AutoStats = {
    STORAGE_KEY,
    FIELDS,
    emptyStats,
    currentMonth,
    mergeDelta,
    messageChars,
    cacheHitRate,
    read,
    add,
    reset,
    applyWrite,
  };
})(globalThis);
