// 决策层：这一页现在该不该**自己**翻译。
//
// 纯函数，零 I/O，零 DOM —— 调用方把「我看到的事实」交进来，这里只回答该怎么
// 办。放在 shared/ 而不是 content/ 就是为了这个：node --test 里直接跑，不需要
// 浏览器，也不需要造一个假的 document。
//
// **边界（别读错）**：decide() 回答的是自动触发。用户自己点「翻译整页」不经过
// 这里——那条路直接走 ctx.translatePage()，黑名单也好、语言规则也好，都管不到
// 它。explicit 参数也不是「用户点了翻译」的开关，它是「这一页用户已经表过态」
// 的事实：页面后来长出来的新内容该不该跟上，问的还是这个函数，答案就得是 auto，
// 否则调度层只能绕过 decide() 自己判一遍——同一个问题两个地方回答，迟早不一致。
//
// 结论里的 reason 是枚举，不是人话。人话在 i18n 里，按枚举取。拼字符串的那一刻
// 它就没法被测试、也没法被翻译了。
(function (root) {
  'use strict';

  // 顺序就是下面那条阶梯的顺序，读枚举等于读一遍决策过程。
  const REASONS = Object.freeze({
    GLOBAL_OFF: 'GLOBAL_OFF',
    BLOCKLIST: 'BLOCKLIST',
    BUILTIN_NEVER: 'BUILTIN_NEVER',
    USER_NEVER: 'USER_NEVER',
    USER_EXPLICIT: 'USER_EXPLICIT',
    USER_ALWAYS: 'USER_ALWAYS',
    BUILTIN_ALWAYS: 'BUILTIN_ALWAYS',
    SAME_LANGUAGE: 'SAME_LANGUAGE',
    LANG_NOT_LISTED: 'LANG_NOT_LISTED',
    UNKNOWN_LANGUAGE: 'UNKNOWN_LANGUAGE',
    DEFAULT_ASK: 'DEFAULT_ASK',
  });

  // 阶梯最上面那四级：**这个站点不许我们自己动手**。
  //
  // 和「verdict === 'off'」不是一回事，这才是它值得单独有个名字的原因。下面还有
  // 三级也答 off，但它们量的是语言——「页面已经是你的语言了」「这门语言不在你的
  // 名单里」——那是「这一页不必翻」，不是「这个站点别碰」。
  //
  // 谁需要分清这两句话：一件自动化要的闸门不总是「这个站点开着自动翻」。整页翻译
  // 之外的自动化（比如替观众点开播放器的原字幕）发生的地方，decide() 多半答的是
  // ask——视频站点没上过内置 always 名单，页面语言又常常和声道语言不是一回事。拿
  // 「开着自动翻」当闸门，那些事在它们最该发生的地方一次也不会发生；拿「被明令拒
  // 绝」当闸门，被拒的四种情形一个不漏，其余照常。
  const REFUSALS = Object.freeze([
    REASONS.GLOBAL_OFF, REASONS.BLOCKLIST, REASONS.BUILTIN_NEVER, REASONS.USER_NEVER,
  ]);

  // ---------------------------------------------------------------- 主机名

  const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

  function cleanHost(hostname) {
    return String(hostname || '').trim().toLowerCase().replace(/\.+$/, '');
  }

  /**
   * 规则的键：就是这台主机本身，只脱掉 www.。
   *
   * 不往上剥到「注册域」。浏览器里没有公共后缀表，任何自己写的启发式都会把
   * alice.github.io 剥成 github.io —— 用户在一个人的站点上点「总是翻译」，
   * 这条规则就悄悄盖住了 github.io 上所有别人的站点。同一个后缀下住着互不
   * 相干的租户（github.io、vercel.app、pages.dev、blogspot.com……），这类
   * 后缀没有尽头，也没法靠一张表穷举。
   *
   * 范围小一点不是问题：lookupUserRule 会沿着主机名一路往上找父域，所以用户
   * 真想覆盖整个站点时，在 x.com 上表的态照样命中 mobile.x.com。反过来多剥
   * 一层，才是替用户做了他没做的决定。
   */
  function normalizeHost(hostname) {
    return cleanHost(hostname).replace(/^www\./, '');
  }

  // 后缀匹配：模式命中它自己，以及它的子域。反过来不成立——规则写 x.com 命中
  // mobile.x.com，规则写 mobile.x.com 不命中 x.com。
  function hostMatches(host, pattern) {
    const h = cleanHost(host);
    const p = cleanHost(pattern);
    if (!h || !p) return false;
    return h === p || h.endsWith(`.${p}`);
  }

  function pathMatches(path, glob) {
    if (!glob || glob === '*') return true;
    const pattern = glob
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    return new RegExp(`^${pattern}$`).test(path || '/');
  }

  // 'arxiv.org/abs/*' -> { host: 'arxiv.org', path: '/abs/*' }
  function splitPattern(pattern) {
    const raw = String(pattern || '');
    const slash = raw.indexOf('/');
    if (slash === -1) return { host: raw, path: '' };
    return { host: raw.slice(0, slash), path: raw.slice(slash) };
  }

  function patternMatches(pattern, host, path) {
    const parts = splitPattern(pattern);
    return hostMatches(host, parts.host) && pathMatches(path, parts.path);
  }

  // ---------------------------------------------------------------- 规则表

  const STATES = new Set(['always', 'never']);
  const STRING_ARRAY_FIELDS = ['atomicBlockSelectors', 'excludeSelectors'];

  function isStringArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === 'string' && item);
  }

  function validRule(rule) {
    if (!rule || typeof rule !== 'object') return false;
    if (typeof rule.match !== 'string' || !rule.match) return false;
    if (!STATES.has(rule.state)) return false;
    if (STRING_ARRAY_FIELDS.some((field) => !isStringArray(rule[field]))) return false;
    if (rule.blockIdAttr !== null && typeof rule.blockIdAttr !== 'string') return false;
    return true;
  }

  /**
   * 校验整张表，返回一张能用的表。表坏了要退化成「翻得碎」，不是「翻不了」，更
   * 不是「崩了」——所以 rules 整个清空，走通用启发式。
   *
   * **整表回退，不是逐条剔除**：一条规则的字段名写错了，说明这次改动没经过测
   * 试，剩下的规则同样不可信；挑着用比全不用更难排查——线上一半站点行为变了，
   * 而日志里什么都没有。
   *
   * 黑名单是唯一的例外面：它是安全侧的东西，坏表也要把能认的那些留下。
   */
  function loadTable(raw) {
    const errors = [];
    const table = raw && typeof raw === 'object' ? raw : {};

    if (table.schemaVersion !== 1) errors.push(`schemaVersion ${table.schemaVersion} is not 1`);
    const rules = Array.isArray(table.rules) ? table.rules : [];
    if (!Array.isArray(table.rules)) errors.push('rules is not an array');
    rules.forEach((rule, i) => {
      if (!validRule(rule)) errors.push(`rules[${i}] (${rule && rule.match}) is malformed`);
    });

    const seen = new Set();
    for (const rule of rules) {
      if (!rule || typeof rule.match !== 'string') continue;
      if (seen.has(rule.match)) errors.push(`duplicate rule for ${rule.match}`);
      seen.add(rule.match);
    }

    const blocklist = Array.isArray(table.blocklist)
      ? table.blocklist.filter((entry) => typeof entry === 'string' && entry)
      : [];
    if (!Array.isArray(table.blocklist)) errors.push('blocklist is not an array');

    if (errors.length) return { rules: [], blocklist, ok: false, errors };
    return { rules, blocklist, ok: true, errors };
  }

  // 这张表是进程里唯一的一份，而 decide() 会把命中的规则原样交出去——适配层要
  // 它的 selector。不冻的话，一句 rule.excludeSelectors.push() 就永久改写了本次
  // 会话的内置表，而且改的是别的站点的行为，下次读到时没有任何痕迹。
  //
  // 冻的是 table() 缓存的那一份，不是 loadTable()：后者是纯校验器，不该动调用
  // 方交进来的对象。
  function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    return value;
  }

  let cached = null;
  function table() {
    if (!cached) {
      cached = deepFreeze(loadTable(root.SiteRulesBuiltin));
      if (!cached.ok) {
        console.warn('Blab Translation: built-in site rules rejected, falling back', cached.errors);
      }
    }
    return cached;
  }

  /**
   * 命中的内置规则，没有就是 null。
   * 同时命中多条时取 match 最长的那条（最具体的赢），与声明顺序无关。
   */
  function matchBuiltin(host, path) {
    let best = null;
    for (const rule of table().rules) {
      if (!patternMatches(rule.match, host, path)) continue;
      if (!best || rule.match.length > best.match.length) best = rule;
    }
    return best;
  }

  function isBlocked(host, path) {
    return table().blocklist.some((pattern) => patternMatches(pattern, host, path));
  }

  /**
   * 「这一页永远不自己翻，用户说了也不算」。
   *
   * 黑名单和内置表里的 never 是同一件事的两种写法，对外只有一个说法 —— 所以这
   * 一问必须有一个主人，下面的阶梯自己也问它。
   *
   * 单拎出来是因为 decide() 的答案在这个问题上**会被遮住**：总开关关着时它第一
   * 档就回 GLOBAL_OFF，谁也看不出这一页其实还被拉着黑。要据此把界面上那个站点
   * 开关灰掉的调用方，问的就得是这一问，不能去读那个被遮住的 reason。
   */
  function isBlocklisted(host, path) {
    if (isBlocked(host, path)) return true;
    const rule = matchBuiltin(host, path);
    return !!(rule && rule.state === 'never');
  }

  /**
   * 「界面上那一行『自动翻译这个站点』写得进去吗」。
   *
   * 写不进去的有两种，都得让那一行看起来就点不动：黑名单站点（BLOCKLIST 在
   * decide() 的阶梯上排在 USER_ALWAYS 前面，写进去也不算数），和 normalizeHost
   * 生不出键来的页面（file:// 上 location.hostname 是空串）。后一种按下去
   * setSiteAuto 会抛，前一种按下去更糟：规则存了、也读回来了，可这一页照样不
   * 翻，而用户以为他刚刚打开了它。
   *
   * 三处画这一行的地方 —— popup、播放器里的字幕菜单、悬浮球菜单第一项 —— 问的
   * 是同一句话，所以只有这一份实现。从前它是字幕菜单里的一个私有函数，第二处要
   * 用的时候差一点就被抄成第二份。
   *
   * 参数而不是读 location：这个文件在服务工作者里也装着，那边没有 location。
   */
  function siteRuleWritable(hostname, path) {
    if (!normalizeHost(hostname)) return false;
    return !isBlocklisted(hostname, path);
  }

  // ---------------------------------------------------------------- 语言

  // 语言标签的判定只有一个主人：shared/lang-tags.js。这里连一份副本都不留，
  // 就是转手——曾经这里、caption-core 和 content-language.js 各写过一份，
  // 于是同一对语言在整页翻译里算「同语言」、在字幕里不算。
  // 取不到就立刻炸：装载顺序错了的表现否则是「语言那几档静静地判错」。
  const LangTags = root.LangTags;
  if (!LangTags) throw new Error('site-rules.js 要先装 shared/lang-tags.js');
  const baseLang = LangTags.getLangBase;

  // ---------------------------------------------------------------- 用户规则

  // 沿父域往上找：a.b.x.com 依次问 a.b.x.com、b.x.com、x.com。用户显式写下的
  // 域名才会命中它自己和它的子域，绝不会因为归一化把整个后缀圈进来。
  //
  // 两头都要停：
  //   - 光秃秃的顶级域（com、org）永远不问。那是一条能把半个互联网圈进去的规
  //     则，不该因为某次拼接意外生效。
  //   - 单标签主机（localhost、公司内网的 wiki）只问它自己。它没有父域，但
  //     normalizeHost 原样返回它，用户在这种页面上点「总是翻译」就存在这个键
  //     下——不问它，那条规则写下去就永远不生效。
  function lookupUserRule(userRules, host) {
    if (!userRules || typeof userRules !== 'object') return '';
    const clean = cleanHost(host);
    if (!clean) return '';

    const hit = (candidate) => {
      const value = userRules[candidate];
      return (value === 'always' || value === 'never') ? value : '';
    };

    // IP 也没有父域可言：10.0.0.7 的「父域」0.0.7 是个不存在的东西。
    if (IPV4_RE.test(clean) || !clean.includes('.')) return hit(clean);

    const labels = clean.split('.');
    for (let i = 0; i + 1 < labels.length; i++) {
      const value = hit(labels.slice(i).join('.'));
      if (value) return value;
    }
    return '';
  }

  // ---------------------------------------------------------------- 决策

  /**
   * @param {Object} input
   * @param {string}  input.host        location.hostname
   * @param {string}  input.path        location.pathname
   * @param {?string} input.pageLang    页面语言，判不出时为 null
   * @param {string}  input.targetLang  已经解析过的目标语言（空 = 还不知道）
   * @param {Object}  input.userRules   { 'x.com': 'always' | 'never' }
   * @param {Object}  input.settings    { autoTranslate, autoTranslateLangs }
   * @param {boolean} input.explicit    用户已经在这一页表过态
   * @returns {{verdict: 'auto'|'ask'|'off', reason: string, rule: ?Object,
   *            refused: boolean}} refused 见 REFUSALS：站点级的拒绝，不含语言结论。
   */
  function decide(input) {
    const {
      host = '', path = '/', pageLang = null, targetLang = '',
      userRules, settings, explicit = false,
    } = input || {};
    // 解构的默认值只补 undefined。设置还没读回来时传进来的是 null，那时候
    // settings.autoTranslate 会直接抛——而这个函数的整个价值就在于它不抛。
    const prefs = settings || {};

    // 命中的规则跟着每一个结论走：适配层要它的 selector，和「这次翻不翻」无关。
    const rule = matchBuiltin(host, path);
    const out = (verdict, reason) => ({
      verdict, reason, rule, refused: REFUSALS.indexOf(reason) !== -1,
    });

    // 总开关管的是「我们自己开始翻」。用户已经在这一页动过手的，它拦不住——
    // 所以这里带上 explicit，而不是把 explicit 塞到它后面去：一个没翻过的页面
    // 在总开关关着时，理由该是「自动翻译已关闭」这条能操作的，而不是别的。
    if (!explicit && !prefs.autoTranslate) return out('off', REASONS.GLOBAL_OFF);

    // 禁翻的三条在所有「要翻」的理由之前，包括用户自己设的总是翻译。它防的不
    // 是「用户想翻银行页面」，是「用户在某个域名上点过一次总是翻译，此后我们
    // 往他的邮箱、在线文档编辑器、政务表单里插节点」。
    //
    // 同一个结论有两种来源，而用户看到的那句话不一样：黑名单说的是「这类页面
    // 我们不碰」，内置 never 说的是「这一条路径我们另有安排」—— arxiv 的
    // /pdf/ 就是后者，那里不是不该翻，是该走另一条（收费的）路，页面上那条
    // 提示条正等着他点。两句话混成一句，用户在论文 PDF 上看到的会是「这个站点
    // 在黑名单里」，而他上一秒还在同一个域名下读着被自动翻好的摘要页。
    //
    // 判断仍然只问 isBlocklisted() 这一个主人，问完再回头看是哪一半答的是。
    // 反过来把两半就地展开，就等于在这里复制了一遍那个函数：哪天它多认一种
    // never，这条阶梯会悄悄漏掉。落到 BUILTIN_NEVER 是安全的那一边 —— 结论
    // 一模一样，只是措辞按「内置规则说不」来。
    if (isBlocklisted(host, path)) {
      return out('off', isBlocked(host, path) ? REASONS.BLOCKLIST : REASONS.BUILTIN_NEVER);
    }
    const userRule = lookupUserRule(userRules, host);
    if (userRule === 'never') return out('off', REASONS.USER_NEVER);

    // 用户在这一页已经动过手了。后面长出来的内容跟上是在兑现那次点击，不是替
    // 他做主，所以语言规则也好、总开关也好，都不该在这里再拦一次。
    if (explicit) return out('auto', REASONS.USER_EXPLICIT);

    if (userRule === 'always') return out('auto', REASONS.USER_ALWAYS);
    if (rule && rule.state === 'always') return out('auto', REASONS.BUILTIN_ALWAYS);

    // 比整码，不比基码：zh-CN 的页面配 zh-TW 的目标是两套字，而「繁转简」正是
    // 用户要的那一件事——按基码判，这一档会答「这一页本来就是你的语言」，整页
    // 一个字也不翻。字幕那边早就是这个口径了，这里曾经不是。
    if (LangTags.isSameLanguage(pageLang, targetLang)) return out('off', REASONS.SAME_LANGUAGE);

    // 下面这一档反过来，**必须**按基码：autoTranslateLangs 是用户在设置里勾的
    // 语言，勾的是「中文」不是「简体中文」。拿整码比，一个勾了 zh 的用户会被
    // 这一档挡在所有 zh-CN 的页面外面。
    const page = baseLang(pageLang);
    const listed = Array.isArray(prefs.autoTranslateLangs) ? prefs.autoTranslateLangs : [];
    if (listed.length && page && !listed.some((lang) => baseLang(lang) === page)) {
      return out('off', REASONS.LANG_NOT_LISTED);
    }

    // 判不出语言就不赌：问一句，不自作主张。
    if (!pageLang) return out('ask', REASONS.UNKNOWN_LANGUAGE);

    return out('ask', REASONS.DEFAULT_ASK);
  }

  // ---------------------------------------------------------------- 写规则

  // 同步存储上的「读—改—写」只能有一个主人。
  //
  // 站点规则和追问计数各自是一整个对象里的一个键：读出来、改一个键、整份写回。
  // 同一个域名开着三个标签页，或者用户一边在 popup 上点「关」、一边追问条在给
  // 另一个域名记数，两边都会先读到同一份旧对象，后写的那份把先写的整个盖掉 ——
  // 用户点下的选择就这么没了，而且哪里都不报错。
  //
  // 所以写入点收到服务工作者里：它是单实例，配上一条队列（两条消息的处理照样
  // 能在 await 处交错）就能把这些改动串成一条线。队列只保证顺序、不传播失败：
  // 一次写崩了不该把后面的全卡死。
  const IN_SERVICE_WORKER =
    typeof ServiceWorkerGlobalScope !== 'undefined' && root instanceof ServiceWorkerGlobalScope;

  let writeQueue = Promise.resolve();

  function enqueue(run) {
    const result = writeQueue.then(run, run);
    writeQueue = result.catch(() => {});
    return result;
  }

  // 两张表都按域名一路长下去，而同步存储是**每项** 8KB：撑爆的那天 set() 直接
  // 失败。追问计数失败了是上限静悄悄不再生效，站点规则失败了是用户刚点下的选择
  // 根本没存上。所以两张表共用一道预算，也共用一个量法。
  //
  // 按**序列化之后的字节数**算，不按条数。撑爆配额的是字节：一条记录占多少取决
  // 于主机名有多长，两百个 40 字符的域名就已经贴着 8KB，而域名可以长得多。按条
  // 数封顶只是把那天推远一点，并没有堵上。8KB 里只留 6KB，剩下的是给键名本身和
  // 「Chrome 怎么数」留的余量 —— 差那一点就写不进去，代价是整张表。
  const MAX_ITEM_BYTES = 6 * 1024;

  function itemBytes(value) {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  }

  // 追问计数满了先扔计数最小的（被问得最少的那几个，重新问一次的代价也最小），
  // 刚动过的那条永远留着。被扔掉的站点最多是多被问几次，用户表过的态一点没丢
  // —— 那些在 siteRules 里，是另一张表。
  function pruneAskCounts(counts, keep) {
    if (itemBytes(counts) <= MAX_ITEM_BYTES) return counts;
    const victims = Object.keys(counts)
      .filter((key) => key !== keep)
      .sort((a, b) => counts[a] - counts[b]);
    for (const key of victims) {
      delete counts[key];
      if (itemBytes(counts) <= MAX_ITEM_BYTES) break;
    }
    return counts;
  }

  /**
   * 站点规则满了：扔掉**扔了也不改变任何判定**的那些。
   *
   * 这张表不能像计数那样挑一条扔 —— 每一条都是用户亲口说过的话，扔掉哪一条都
   * 是替他改主意。但表里会有真正多余的条目：用户先在 x.com 上点了「总是翻译」，
   * 后来又在 mobile.x.com 上点了一次同样的，而 lookupUserRule 本来就会沿父域
   * 往上找 —— 删掉子域那条，mobile.x.com 查出来还是 always。
   *
   * 「多余」不靠眼力判断，靠查一遍：删掉之后再用同一个函数查这个键，答案一样
   * 才真的多余。这样单标签主机（localhost 和它下面的 wiki.localhost）、自己
   * 写死的例外（x.com=always 而 ads.x.com=never）都不会被误收 —— 前者查出来
   * 是空，后者查出来是相反的那个。从最长的键扫起：最深的子域最可能被盖住。
   *
   * **只在超预算时跑**，不平时清理。子域那条今天多余，不等于明天多余：用户哪
   * 天把 x.com 改成 never，留着的 mobile.x.com=always 还护得住那个子域，收掉
   * 了就跟着变成 never —— 一次没人看见的改主意。顶着配额失败去换这个风险值得，
   * 平白无故去换不值得。真正的泄压阀是设置页里那张能删的审计表（PR-10）。
   */
  function compactUserRules(rules, keep) {
    if (itemBytes(rules) <= MAX_ITEM_BYTES) return rules;
    const keys = Object.keys(rules)
      .filter((key) => key !== keep)
      .sort((a, b) => b.length - a.length);
    for (const key of keys) {
      const state = rules[key];
      delete rules[key];
      if (lookupUserRule(rules, key) !== state) rules[key] = state;
      else if (itemBytes(rules) <= MAX_ITEM_BYTES) break;
    }
    return rules;
  }

  /**
   * 写下一条用户站点规则，或把它抹掉（state 不是 always/never 时）。
   *
   * 放在这里而不是三个调用方各写一遍：**存进去的那把钥匙必须和 decide() 查的
   * 那把是同一把**。追问条、popup、设置页都要写这张表，只要有一处忘了
   * normalizeHost（或者哪天归一化规则变了而只改了两处），用户点下的「总是翻译」
   * 就存在一个永远查不到的键上 —— 按钮有反应、规则也确实写进去了，页面就是不
   * 翻，而且哪里都不报错。
   *
   * @returns {Promise<string>} 实际用的键，写不成时是空串。
   */
  async function applyUserRule({ host, state }) {
    const key = normalizeHost(host);
    const store = root.chrome && root.chrome.storage && root.chrome.storage.sync;
    if (!key || !store) return '';
    const stored = await store.get({ siteRules: {} });
    const rules = Object.assign({}, stored.siteRules);
    if (STATES.has(state)) rules[key] = state;
    else delete rules[key];
    compactUserRules(rules, key);
    // 挤不下就让它抛。这条路上只有用户刚点的那一下，调用方看得见失败、也说得
    // 出口；吞掉它才是那种「按钮动了、设置没存上」的坏结局。
    await store.set({ siteRules: rules });
    return key;
  }

  /**
   * 这个域名被追问过几次：读出来、加一、写回去。`'clear'` 是把整条记录删掉
   * ——用户表过态了，前面问过几次都不算数。
   *
   * @returns {Promise<number>} 写完之后的次数
   */
  async function applyAskCount({ host, op }) {
    const key = normalizeHost(host);
    const store = root.chrome && root.chrome.storage && root.chrome.storage.sync;
    if (!key || !store) return 0;
    const stored = await store.get({ siteAskCount: {} });
    const counts = Object.assign({}, stored.siteAskCount);
    const current = typeof counts[key] === 'number' && counts[key] > 0 ? counts[key] : 0;
    if (op === 'clear') {
      delete counts[key];
    } else {
      counts[key] = current + 1;
      pruneAskCounts(counts, key);
    }
    await store.set({ siteAskCount: counts });
    return op === 'clear' ? 0 : current + 1;
  }

  const WRITES = { rule: applyUserRule, ask: applyAskCount };

  /**
   * 服务工作者的入口：把一条写入请求排进队列。背景页的消息分发只管转接，规则
   * 本身不在那边（background.js 的 SITE_RULES_WRITE）。
   */
  function applyWrite(message) {
    const write = message && WRITES[message.kind];
    if (!write) return Promise.reject(new Error(`unknown site-rules write: ${message && message.kind}`));
    return enqueue(() => write(message));
  }

  // 在服务工作者里就自己写，在别处就把这件事交给它。调用方两边共用一个名字，
  // 省得每个写入点都要记得自己是谁、该不该发消息。
  function request(kind, payload) {
    const message = Object.assign({ type: 'SITE_RULES_WRITE', kind }, payload);
    if (IN_SERVICE_WORKER) return applyWrite(message);
    return root.chrome.runtime.sendMessage(message).then((reply) => {
      if (reply && reply.error) throw new Error(reply.error);
      return reply ? reply.value : undefined;
    });
  }

  function writeUserRule(hostname, state) {
    return request('rule', { host: hostname, state });
  }

  function updateAskCount(hostname, op) {
    return request('ask', { host: hostname, op });
  }

  /**
   * 「这个站点自动翻 / 不自动翻」——一个开关的两件事，写在一处。
   *
   * 开写 always、关写 never。**关不能是「把规则删掉」**：删掉之后判定会往下落到
   * 内置名单，而 x.com、reddit.com 这些在内置名单里就是 always —— 用户刚把它关
   * 掉，下一次打开又自动翻了，而且规则表里干干净净，他连去哪儿改都找不到。
   *
   * 开的时候顺带把总开关打开：用户刚指着这个站点说「自动翻」，因为一个他此刻看
   * 不见的总开关而什么都不发生，是最坏的一种没反应。总开关本身默认就是开的，这
   * 一步只在他自己关过之后才有事做。
   *
   * 顺序是有意的：规则写不进去（同步存储每项 8KB，规则表按域名一路长下去）的时
   * 候，总开关不该已经替所有别的站点开好了 —— 他要的是这一个站点，拿到的会是整
   * 个浏览器。反过来那半边漏掉不伤人：规则落了地而总开关没开，再点一次就补上了。
   *
   * 黑名单站点由调用方自己挡（画面上那一行要灰掉，见 popup 和字幕菜单）：
   * BLOCKLIST 在 decide() 的阶梯上排在 USER_ALWAYS 前面，写进去也不算数，而顺带
   * 打开总开关这个副作用会照跑。
   *
   * 存不进规则表的 host 在这里就拦住。file:// 页面上 location.hostname 是空串，
   * normalizeHost 给不出键，writeUserRule 会一声不响地什么都不写 —— 而后面那半
   * 边照跑：一个写着「这个站点」的开关，按下去把整个浏览器的总开关打开了。抛出
   * 去而不是默默返回，调用方才说得出「没存上」。
   *
   * 两个调用点：popup 那一行，和播放器里字幕菜单的第一项。字幕翻译并进主开关之
   * 后它们说的是同一句话，所以也只该有一份实现。
   */
  async function setSiteAuto(hostname, on) {
    if (!normalizeHost(hostname)) throw new Error(`site rules: unusable host ${hostname}`);
    await writeUserRule(hostname, on ? 'always' : 'never');
    if (!on) return;
    const store = root.chrome && root.chrome.storage && root.chrome.storage.sync;
    if (!store) return;
    const stored = await store.get({ autoTranslate: true });
    if (stored.autoTranslate === false) await store.set({ autoTranslate: true });
  }

  root.SiteRules = {
    REASONS,
    decide,
    normalizeHost,
    // 导出是为了设置页：那份语言名单画在界面上，勾哪几个得和 decide() 认哪几个
    // 是同一个口径。设置页再抄一份 split('-')[0] 就是这张表的第四份副本。
    baseLang,
    lookupUserRule,
    writeUserRule,
    setSiteAuto,
    updateAskCount,
    applyWrite,
    matchBuiltin,
    isBlocklisted,
    siteRuleWritable,
    loadTable,
  };
})(globalThis);
