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
// 纯函数（currentMonth / mergeDelta / textsChars / cacheHitRate）放在最上面，
// node --test 里直接跑，不需要 chrome。
(function (root) {
  'use strict';

  const STORAGE_KEY = 'autoStats';

  // 四个都是单调累加的计数。命中率不在里面，因为**比率没法累加**：这个月前半
  // 段 50%、后半段 80%，两个数字加起来没有任何意义。存两个计数、要用的时候现
  // 除，是这件事唯一不会算错的做法。
  const FIELDS = Object.freeze(['pages', 'aiChars', 'cacheHits', 'cacheMisses']);

  // 按天清零的那一格，和上面四个装在同一条记录里。
  //
  // 它不是「统计」而是**闸门的读数**（FR-9 的每日预算），可还是放在这里：两边
  // 数的是同一件事——真的发给模型的字符数，只是窗口不一样。分成两条记录就有了
  // 两个读—改—写的主人、两套跨期清零的判断，而它们迟早会对不上；那时用户看到
  // 的「本月已用」和闸门认的「今天已用」会是两笔互相矛盾的账。
  //
  // 只数**自动模式**发出去的那部分：手动翻译是用户一次一次点出来的，他知道自己
  // 在花钱；闸门要挡的是零点击的那条路。所以它不和 aiChars 共用记账点 ——
  // aiChars 记在 background/api-client.js 的 countCharsSentToModel()，那里每一次
  // 调模型都过，分不出是谁点的；autoAiChars 记在闸门自己那一处，
  // content/content-translation-engine.js 的 refuseAutoAiSpend()，而且和「还够
  // 吗」是同一次操作（见下面的 applyCharge）。
  const DAY_FIELDS = Object.freeze(['autoAiChars']);

  function emptyStats(month, day) {
    return {
      month: month || '', pages: 0, aiChars: 0, cacheHits: 0, cacheMisses: 0,
      day: day || '', autoAiChars: 0
    };
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

  /**
   * `'YYYY-MM-DD'`，同样按**本地**时区。
   *
   * 预算说的是「今天」，而今天什么时候结束由用户的时区说了算：按 UTC 切的话，
   * 东八区的用户在早上八点就会莫名其妙地多出一天的额度，而美西的用户下午五点
   * 就被清零一次。
   */
  function currentDay(now) {
    const date = now instanceof Date ? now : new Date();
    const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
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
  function mergeDelta(stats, delta, month, day) {
    const base = stats && stats.month === month ? stats : null;
    // 两个窗口各自判各自的期：一条记录跨月不跨日（月初那一天）和跨日不跨月
    // （每天）都是常态，共用一个 base 会让其中一半在该清零的时候没清。
    const dayBase = stats && stats.day === day ? stats : null;
    const next = emptyStats(month, day);
    for (const field of FIELDS) {
      next[field] = count(base && base[field]) + count(delta && delta[field]);
    }
    for (const field of DAY_FIELDS) {
      next[field] = count(dayBase && dayBase[field]) + count(delta && delta[field]);
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
  function textsChars(texts) {
    if (!Array.isArray(texts)) return 0;
    let total = 0;
    for (const text of texts) {
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

  /**
   * 今天的自动模式还有预算吗（FR-9）。
   *
   * `budget <= 0` 是**不限制**，不是「一个字符都不许」：设置页那个输入框留空、
   * 或者用户填了 0，说的都是「别管我」。和 autoTranslateLangs 空数组同一个约定。
   *
   * 比的是 `>=`：预算是「今天最多发这么多」，刚好填满就该停，而不是等下一批
   * 把它顶破。
   */
  function budgetExceeded(stats, budget) {
    const limit = typeof budget === 'number' && Number.isFinite(budget) ? Math.floor(budget) : 0;
    if (limit <= 0) return false;
    return count(stats && stats.autoAiChars) >= limit;
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
    const day = currentDay(now);
    const store = storage();
    if (!store) return Promise.resolve(emptyStats(month, day));
    return store
      .get({ [STORAGE_KEY]: null })
      .then((stored) => mergeDelta(stored && stored[STORAGE_KEY], null, month, day))
      .catch(() => emptyStats(month, day));
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
    const day = currentDay();
    const stored = await store.get({ [STORAGE_KEY]: null });
    const next = mergeDelta(stored && stored[STORAGE_KEY], message.delta, month, day);
    await store.set({ [STORAGE_KEY]: next });
    return next;
  }

  async function applyReset() {
    const store = storage();
    if (!store) return null;
    const next = emptyStats(currentMonth(), currentDay());
    await store.set({ [STORAGE_KEY]: next });
    return next;
  }

  /**
   * 「今天还有额度吗？有就把这一笔记上。」—— **问和记是同一次操作**。
   *
   * 分成 read + add 两步是错的，而且错得看不出来：一轮自动翻译会同时放出八个
   * 批次，八个都在各自的 read 里看到「还没超」，然后八个一起记账。预算是一道
   * 闸门，闸门不能有八个人同时通过的写法。这里走的是下面那条单写者队列，所以
   * 判定用的数字就是写入时的数字。
   *
   * 拒了就一个字都不记 —— 没发出去的字符不该算进今天的用量。
   */
  async function applyCharge(message) {
    const store = storage();
    // 读不到存储就不设闸：预算是本机的一层自我约束，不是权限。存储坏了的时候
    // 把用户的自动翻译整个停掉，比超一点预算糟糕得多。
    if (!store) return { allowed: true, stats: null };
    const month = currentMonth();
    const day = currentDay();
    const stored = await store.get({ [STORAGE_KEY]: null });
    const current = mergeDelta(stored && stored[STORAGE_KEY], null, month, day);
    if (budgetExceeded(current, message.budget)) return { allowed: false, stats: current };
    const next = mergeDelta(current, { autoAiChars: count(message.chars) }, month, day);
    await store.set({ [STORAGE_KEY]: next });
    return { allowed: true, stats: next };
  }

  const WRITES = { add: applyAdd, reset: applyReset, charge: applyCharge };

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
   * `{ pages, aiChars, cacheHits, cacheMisses, autoAiChars }`。
   */
  function add(delta) {
    return request('add', { delta });
  }

  // 用户在设置页按下「清除」。清的是这台电脑上的这一份，别处没有第二份。
  function reset() {
    return request('reset');
  }

  /**
   * 自动模式要发 `chars` 个字符给模型，今天的上限是 `budget`（0 = 不限）。
   * 返回 `{allowed, stats}`。
   *
   * 消息发不出去时（页面正在卸载、扩展刚更新）request 给回 null —— 当成放行：
   * 见 applyCharge 里那句「预算不是权限」。
   */
  function charge(chars, budget) {
    return request('charge', { chars, budget }).then((value) => value || { allowed: true, stats: null });
  }

  root.AutoStats = {
    STORAGE_KEY,
    FIELDS,
    DAY_FIELDS,
    emptyStats,
    currentMonth,
    currentDay,
    mergeDelta,
    textsChars,
    cacheHitRate,
    budgetExceeded,
    read,
    add,
    charge,
    reset,
    applyWrite,
  };
})(globalThis);
