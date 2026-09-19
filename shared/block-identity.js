// 内容身份：这个元素上挂着的译文，还是它现在这段文字的译文吗。
//
// 在这之前，「翻过了」是靠源元素上的 `.ai-translator-translated` 记住的。那是
// **节点身份**，而 X / Reddit 是虚拟列表：滚动时 DOM 节点被回收再利用，class 还
// 在，里面的文字已经换成另一条推文了。结果是新内容被静默跳过——不报错，不重
// 试，只是永远不翻。整页翻译点一次就结束，所以这个洞一直没露出来；自动翻译要
// 一直跟着页面跑，它就是第一块必须先补的地基。
//
// 这里只回答「是不是同一段内容」。把译文节点从 DOM 里摘掉是 content/page/insert.js
// 的事（见那边的 releaseTranslation）——插入有五种形态（兄弟、块内、slot 内、
// flex 内联、受管容器的 ::after），只有它知道自己插的是哪一种。让 shared/ 去摘
// 节点，就得让 shared/ 认识 ctx.releaseManagedTranslation，这个模块也就再也不能
// 在 node --test 里跑了。
//
// 注册表用 WeakMap，不往 DOM 上写 data-* 属性：
//
//   1. 写属性会触发我们自己的 MutationObserver，等于给发现层持续制造噪声，然后
//      还要再写一层过滤去认出自己的写入——引入一个问题再去解决它。
//   2. 污染宿主页面。站点自己的 selector、快照测试、CSP 报告都可能撞上。
//   3. WeakMap 跟着节点一起被 GC 回收，不漏；data-* 得手工清。
//
// 代价是跨 document 的节点克隆会丢失身份——而那正是想要的：克隆体是新节点，
// 本来就该重新翻译。
(function (root) {
  'use strict';

  // WeakMap<Element, {fingerprint, translationEl, managed}>
  const registry = new WeakMap();

  const FNV_OFFSET = 0x811c9dc5;
  const FNV_PRIME = 0x01000193;

  /**
   * 归一化：NFC + 折叠空白 + trim。
   *
   * **不转小写，也不剥内联标记**，这一点和 collect.js 的 normalizeComparableText
   * 正相反，因为两者问的不是同一个问题：那边问「模型是不是把原文原样还回来
   * 了」，宽容一点才不会把大小写差异当成真译文；这边问「这段文字变了没有」，
   * 大小写变了就是变了，把它抹掉等于漏报。
   */
  function normalize(text) {
    if (!text) return '';
    let value = String(text);
    // 组合字符的两种写法（é 与 e+◌́）在页面上一模一样，不归一化就是两个 hash。
    if (value.normalize) value = value.normalize('NFC');
    return value.replace(/\s+/g, ' ').trim();
  }

  /**
   * FNV-1a 32 位，输出 8 位十六进制。
   *
   * 不用密码学哈希：这里不防篡改，只要快和稳定。32 位的碰撞概率在这里也不是
   * 生日问题——比较永远发生在**同一个元素**的新旧两段文字之间，不是全页互
   * 比，所以是 1/2^32 的单次碰撞，代价还只是「这一块漏翻一次」。
   */
  function hash(text) {
    const value = text == null ? '' : String(text);
    let h = FNV_OFFSET;
    for (let i = 0; i < value.length; i++) {
      h ^= value.charCodeAt(i);
      h = Math.imul(h, FNV_PRIME);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  // 登记和比对必须走同一个入口，否则一边 normalize 了一边没有，每一块都会被判
  // 成陈旧，翻完立刻重翻——是个会烧钱的死循环。
  function fingerprint(text) {
    return hash(normalize(text));
  }

  function register(element, entry) {
    if (!element || typeof element !== 'object') return null;
    const record = {
      fingerprint: (entry && entry.fingerprint) || fingerprint(''),
      translationEl: (entry && entry.translationEl) || null,
      managed: !!(entry && entry.managed),
      // 译成了哪门语言。不揉进 fingerprint —— 那个哈希回答的是「这段原文变了
      // 没有」，把目标语言掺进去，虚拟列表的回收判定和换目标语言的判定就再也
      // 分不开了。两个问题分开存、分开问。
      //
      // 没说就存 null，isStale 见到 null 一律不问这一问：漏问只是回到从前
      // （旧语言的译文继续挂着），而把「没说」当成某个具体值会让每一块都判成
      // 陈旧 —— 放开、重翻、再登记、再判陈旧，是个烧钱的死循环。
      lang: entry && entry.lang != null ? String(entry.lang) : null,
    };
    registry.set(element, record);
    return record;
  }

  function lookup(element) {
    if (!element || typeof element !== 'object') return undefined;
    return registry.get(element);
  }

  /**
   * 挂在这个元素上的译文过期了没有。两种过期，都要问：
   *
   *   1. **内容换了** = 节点被复用（虚拟列表）。
   *   2. **目标语言换了**。原文一个字没动，但那条译文是上一门语言的。这一问不
   *      问的话，改完目标语言的页面是花的：先前翻过的块留着旧语言，新长出来的
   *      块是新语言，而且再也没有东西会把旧的那批换过来 —— 内容身份没变，它们
   *      每一轮都被当成「已经翻好了」跳过。
   *
   * 没登记过的元素返回 false 而不是 true：「陈旧」说的是「这里的译文过期了」，
   * 一个从没翻过的元素没有过期的东西。调用方先 lookup 再问这一句。
   *
   * `targetLang` 省略（或登记时没说）就不问第 2 问 —— 见 register 里那段：漏问
   * 是安全的方向，误判成陈旧不是。
   */
  function isStale(element, currentFingerprint, targetLang) {
    const entry = registry.get(element);
    if (!entry) return false;
    if (entry.fingerprint !== currentFingerprint) return true;
    if (targetLang == null || entry.lang == null) return false;
    return entry.lang !== targetLang;
  }

  function forget(element) {
    if (!element || typeof element !== 'object') return false;
    return registry.delete(element);
  }

  // normalize 和 hash 不导出：它们分开用就是两个归一化口径的开始，而这个模块的
  // 全部价值在于「登记和比对走同一个入口」。外面只该看得见 fingerprint。
  root.BlockIdentity = {
    fingerprint,
    register,
    lookup,
    isStale,
    forget,
  };
})(globalThis);
