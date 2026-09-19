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
    USER_NEVER: 'USER_NEVER',
    USER_EXPLICIT: 'USER_EXPLICIT',
    USER_ALWAYS: 'USER_ALWAYS',
    BUILTIN_ALWAYS: 'BUILTIN_ALWAYS',
    SAME_LANGUAGE: 'SAME_LANGUAGE',
    LANG_NOT_LISTED: 'LANG_NOT_LISTED',
    UNKNOWN_LANGUAGE: 'UNKNOWN_LANGUAGE',
    DEFAULT_ASK: 'DEFAULT_ASK',
  });

  // ---------------------------------------------------------------- 主机名

  // 二级通用标签 + 两字母国家顶级域 = 公共后缀：co.uk、com.cn、ac.jp、gov.au……
  // 一条规则顶掉一张会过期的表。co.com 之类不是国家域，不受影响。
  const GENERIC_SLD = new Set([
    'co', 'com', 'net', 'org', 'edu', 'gov', 'ac', 'mil', 'gob', 'go', 'or', 'ne', 'nom',
  ]);

  const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

  function cleanHost(hostname) {
    return String(hostname || '').trim().toLowerCase().replace(/\.+$/, '');
  }

  /**
   * 注册域：mobile.x.com -> x.com。
   *
   * 这只用来决定「用户点总是翻译时，这条规则存在哪个键下」。**查的时候不依赖
   * 它**：lookupUserRule 会沿着主机名一路往上找父域，所以就算这里对某个冷门后
   * 缀判断保守了，精确写下的那条规则依然命中。少剥一层只是范围小一点，多剥一
   * 层才是真的错——所以宁可少剥。
   */
  function normalizeHost(hostname) {
    const host = cleanHost(hostname).replace(/^www\./, '');
    if (!host) return '';
    // IP 和 localhost 这类单标签主机没有注册域可言，原样返回。
    if (IPV4_RE.test(host) || host.includes(':') || !host.includes('.')) return host;

    const labels = host.split('.');
    if (labels.length <= 2) return host;
    const sld = labels[labels.length - 2];
    const tld = labels[labels.length - 1];
    const keep = (tld.length === 2 && GENERIC_SLD.has(sld)) ? 3 : 2;
    return labels.slice(-keep).join('.');
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

  // ---------------------------------------------------------------- 语言

  // 与 content-language.js 的 ctx.getLangBase、caption-core 的 getLangBase 同一个
  // 口径，site-rules.test.mjs 拿一张表逐项比对两者的输出。
  function baseLang(lang) {
    if (!lang) return '';
    return String(lang).split('-')[0].toLowerCase();
  }

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
   * @returns {{verdict: 'auto'|'ask'|'off', reason: string, rule: ?Object}}
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
    const out = (verdict, reason) => ({ verdict, reason, rule });

    // 总开关管的是「我们自己开始翻」。用户已经在这一页动过手的，它拦不住——
    // 所以这里带上 explicit，而不是把 explicit 塞到它后面去：一个没翻过的页面
    // 在总开关关着时，理由该是「自动翻译已关闭」这条能操作的，而不是别的。
    if (!explicit && !prefs.autoTranslate) return out('off', REASONS.GLOBAL_OFF);

    // 禁翻的三条在所有「要翻」的理由之前，包括用户自己设的总是翻译。它防的不
    // 是「用户想翻银行页面」，是「用户在某个域名上点过一次总是翻译，此后我们
    // 往他的邮箱、在线文档编辑器、政务表单里插节点」。
    if (isBlocked(host, path)) return out('off', REASONS.BLOCKLIST);
    // 内置表里的 never 和黑名单是同一件事的两种写法，对外只有一个说法。
    if (rule && rule.state === 'never') return out('off', REASONS.BLOCKLIST);
    const userRule = lookupUserRule(userRules, host);
    if (userRule === 'never') return out('off', REASONS.USER_NEVER);

    // 用户在这一页已经动过手了。后面长出来的内容跟上是在兑现那次点击，不是替
    // 他做主，所以语言规则也好、总开关也好，都不该在这里再拦一次。
    if (explicit) return out('auto', REASONS.USER_EXPLICIT);

    if (userRule === 'always') return out('auto', REASONS.USER_ALWAYS);
    if (rule && rule.state === 'always') return out('auto', REASONS.BUILTIN_ALWAYS);

    const page = baseLang(pageLang);
    const target = baseLang(targetLang);
    if (page && target && page === target) return out('off', REASONS.SAME_LANGUAGE);

    const listed = Array.isArray(prefs.autoTranslateLangs) ? prefs.autoTranslateLangs : [];
    if (listed.length && page && !listed.some((lang) => baseLang(lang) === page)) {
      return out('off', REASONS.LANG_NOT_LISTED);
    }

    // 判不出语言就不赌：问一句，不自作主张。
    if (!pageLang) return out('ask', REASONS.UNKNOWN_LANGUAGE);

    return out('ask', REASONS.DEFAULT_ASK);
  }

  // ---------------------------------------------------------------- 写规则

  /**
   * 写下一条用户站点规则，或把它抹掉（state 不是 always/never 时）。
   *
   * 放在这里而不是三个调用方各写一遍：**存进去的那把钥匙必须和 decide() 查的
   * 那把是同一把**。追问条、popup、设置页都要写这张表，只要有一处忘了
   * normalizeHost（或者哪天归一化规则变了而只改了两处），用户点下的「总是翻译」
   * 就存在一个永远查不到的键上 —— 按钮有反应、规则也确实写进去了，页面就是不
   * 翻，而且哪里都不报错。
   *
   * 读—改—写，不是整份覆盖：另一个标签页此刻可能正在给别的域名写规则。
   *
   * @returns {Promise<string>} 实际用的键，写不成时是空串。
   */
  async function writeUserRule(hostname, state) {
    const key = normalizeHost(hostname);
    const store = root.chrome && root.chrome.storage && root.chrome.storage.sync;
    if (!key || !store) return '';
    const stored = await store.get({ siteRules: {} });
    const rules = Object.assign({}, stored.siteRules);
    if (STATES.has(state)) rules[key] = state;
    else delete rules[key];
    await store.set({ siteRules: rules });
    return key;
  }

  // 这个域名被追问过几次：读出来、加一、写回去。
  //
  // 这种写法必须只有一个主人。同一个域名可能同时开着三个标签页，三个内容脚本
  // 各自读出 0、各自写回 1，「问三次就不再问」这句承诺永远凑不满三次。所以计数
  // 由服务工作者代劳（background.js 的 SITE_ASK_COUNT），内容脚本只发消息。
  //
  // 服务工作者是单实例，但两条消息的处理之间照样能在 await 处交错，所以这里还要
  // 一条队列把前一次的写等完。队列只保证顺序、不传播失败：一次写崩了不该把后面
  // 的全卡死。
  let askQueue = Promise.resolve();

  /**
   * @param {string} hostname 主机名，内部按 normalizeHost 归一
   * @param {'bump'|'clear'} op 加一，或者把这条记录整条删掉（用户表态了，
   *   前面问过几次都不算数）
   * @returns {Promise<number>} 写完之后的次数
   */
  function updateAskCount(hostname, op) {
    const run = async () => {
      const key = normalizeHost(hostname);
      const store = root.chrome && root.chrome.storage && root.chrome.storage.sync;
      if (!key || !store) return 0;
      const stored = await store.get({ siteAskCount: {} });
      const counts = Object.assign({}, stored.siteAskCount);
      const current = typeof counts[key] === 'number' && counts[key] > 0 ? counts[key] : 0;
      if (op === 'clear') delete counts[key];
      else counts[key] = current + 1;
      await store.set({ siteAskCount: counts });
      return op === 'clear' ? 0 : current + 1;
    };
    const result = askQueue.then(run, run);
    askQueue = result.catch(() => {});
    return result;
  }

  root.SiteRules = {
    REASONS,
    decide,
    normalizeHost,
    lookupUserRule,
    writeUserRule,
    updateAskCount,
    matchBuiltin,
    loadTable,
  };
})(globalThis);
