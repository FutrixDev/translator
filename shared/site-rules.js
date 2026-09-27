// 决策层：这一页现在该不该**自己**翻译。
//
// 纯函数，零 I/O，零 DOM —— 调用方把「我看到的事实」交进来，这里只回答该怎么
// 办。放在 shared/ 而不是 content/ 就是为了这个：node --test 里直接跑，不需要
// 浏览器，也不需要造一个假的 document。
//
// **边界（别读错）**：decide() 回答的是自动触发。用户自己点「翻译整页」不经过
// 这里——那条路直接走 ctx.translatePage()，黑名单也好、站点规则也好，都管不到
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
    BUILTIN_CAPTIONS: 'BUILTIN_CAPTIONS',
    DEFAULT_OFF: 'DEFAULT_OFF',
  });

  // 阶梯最上面那四级：**这个站点不许我们自己动手**。
  //
  // 和「verdict === 'off'」不是一回事，这才是它值得单独有个名字的原因。阶梯最底下
  // 那一级（DEFAULT_OFF，谁都没替这个站点说过话）也答 off，但那是「正文不自己翻」，
  // 不是「这个站点别碰」。
  //
  // 谁需要分清这两句话：一件自动化要的闸门不总是「这个站点开着自动翻」。整页翻译
  // 之外的自动化（比如翻播放器里的字幕）发生的地方，decide() 多半答的是
  // DEFAULT_OFF——大多数视频站点不在内置 always 名单上。拿「开着自动翻」当闸门，
  // 那些事在它们最该发生的地方一次也不会发生；拿「被明令拒绝」当闸门，被拒的四种
  // 情形一个不漏，其余照常。
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

  /**
   * 印在按钮上的站点名：规则存在哪个键下就印哪个，存不下键的页面（file://）
   * 退回原样。「不再自动翻译 {site}」在悬浮球、字幕菜单、popup 三处都有，印的
   * 都是它 —— 按钮上的名字和写进去的键是同一个，三处也不会一处带 www. 一处不带。
   */
  function siteLabel(hostname) {
    return normalizeHost(hostname) || String(hostname || '');
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

  // 用户能写的只有两种。内置表多一种 captions（D-351）：这个站点的正文不自己翻，
  // 但它是字幕站 —— 不是拒绝，字幕照翻（闸门问的是 REFUSALS，见上）。它和
  // DEFAULT_OFF 的结论一样，多出来的是一句说得出口的理由，以及设置页里那张
  // 「内置名单」上的一行，用户看得见、一键就能改。
  const STATES = new Set(['always', 'never']);
  const BUILTIN_STATES = new Set(['always', 'never', 'captions']);
  const STRING_ARRAY_FIELDS = ['atomicBlockSelectors', 'keepOriginalSelectors'];

  function isStringArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === 'string' && item);
  }

  /**
   * 一条规则认的地址：match 可以是一个模式，也可以是一组。
   *
   * 一组是给「同一个站点、好几个门牌」的：Google 学术在各国的域名
   * （scholar.google.co.jp、scholar.google.de……）是同一套页面，selector 只该
   * 写一遍。拆成十几条一模一样的规则，就是十几份要同时改的东西。
   *
   * 不认 `scholar.google.*` 这种主机通配：浏览器里没有公共后缀表，
   * scholar.google.evil.com 也会被它圈进来 —— 内置规则是 always，认错一个站就是
   * 在一个没问过用户的页面上自己动手。主机部分一律是字面后缀，validRule 把带 `*`
   * 的拒在门外（hostMatches 从不展开它，写了只会是一条悄悄失效的规则）。
   */
  function rulePatterns(rule) {
    return Array.isArray(rule.match) ? rule.match : [rule.match];
  }

  function validPattern(pattern) {
    if (typeof pattern !== 'string' || !pattern) return false;
    const { host } = splitPattern(pattern);
    return !!host && !host.includes('*');
  }

  function validRule(rule) {
    if (!rule || typeof rule !== 'object') return false;
    const patterns = rulePatterns(rule);
    if (!patterns.length || !patterns.every(validPattern)) return false;
    if (!BUILTIN_STATES.has(rule.state)) return false;
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

    // 按模式查重，不按规则：同一个地址写在两条规则里（哪怕一条是数组的一员），
    // 赢的那条就取决于声明顺序了。
    const seen = new Set();
    for (const rule of rules) {
      if (!rule || typeof rule !== 'object') continue;
      for (const pattern of rulePatterns(rule)) {
        if (typeof pattern !== 'string') continue;
        if (seen.has(pattern)) errors.push(`duplicate rule for ${pattern}`);
        seen.add(pattern);
      }
    }

    const blocklist = Array.isArray(table.blocklist)
      ? table.blocklist.filter((entry) => typeof entry === 'string' && entry)
      : [];
    if (!Array.isArray(table.blocklist)) errors.push('blocklist is not an array');

    if (errors.length) return { rules: [], blocklist, ok: false, errors };
    return { rules, blocklist, ok: true, errors };
  }

  // 这张表是进程里唯一的一份，而 decide() 会把命中的规则原样交出去——适配层要
  // 它的 selector。不冻的话，一句 rule.keepOriginalSelectors.push() 就永久改写了本次
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
   * 同时命中多条时取命中的那个模式最长的（最具体的赢），与声明顺序无关。比的是
   * **命中的那个模式**，不是规则里最长的那个 —— 一组门牌里有一个长域名，不该让
   * 整条规则在别的门牌上也显得更具体。
   */
  function matchBuiltin(host, path) {
    let best = null;
    let bestLength = -1;
    for (const rule of table().rules) {
      for (const pattern of rulePatterns(rule)) {
        if (pattern.length <= bestLength || !patternMatches(pattern, host, path)) continue;
        best = rule;
        bestLength = pattern.length;
      }
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
   * 画这一行的地方 —— popup、播放器里的字幕菜单、悬浮球菜单第一项 —— 问的是同
   * 一句话，所以只有这一份实现。从前它是字幕菜单里的一个私有函数，第二处要用的
   * 时候差一点就被抄成第二份；popup 那一处则长期只问了黑名单那一半，于是同一个
   * file:// 页面上，两处把这一行灰掉、第三处让它看起来能点。
   *
   * 参数而不是读 location：这个文件在服务工作者里也装着，那边没有 location。
   */
  function siteRuleWritable(hostname, path) {
    if (!normalizeHost(hostname)) return false;
    return !isBlocklisted(hostname, path);
  }

  // 一个 DNS 主机名（含 punycode 的 xn-- 标签和 IPv4），整串不超过 253 字符。
  const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

  /**
   * 设置页「添加站点」那个框里敲进来的一串字，变成规则表的键。
   *
   * 人会贴整条地址（https://www.Example.com/a?b）、会带端口、会敲中文域名。键
   * 必须和 decide() 查的是同一把，所以归一化只能在这里做一次，设置页不自己拼：
   * 脱协议、路径、查询、端口，经 URL 解析把中文域名转成 punycode（地址栏里的
   * location.hostname 也是 punycode），再交给 normalizeHost 脱 www. 和小写。
   *
   * 两种拒绝，调用方各印一句话：
   *   invalid  —— 不是一个主机名（带空格、通配符、IPv6 字面量、解析不了）；
   *   blocked  —— 黑名单或内置 never 上的站点。写 always 进去不算数（阶梯上黑
   *               名单排在用户规则前面），写 never 进去是多余的；两种都让用户以
   *               为他改了什么。和 siteRuleWritable 问的是同一句话。
   *
   * @returns {{host: string} | {error: 'invalid'|'blocked', host?: string}}
   */
  function parseSiteInput(text) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw || /\s/.test(raw)) return { error: 'invalid' };
    let hostname;
    try {
      hostname = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`).hostname;
    } catch (error) {
      return { error: 'invalid' };
    }
    const host = normalizeHost(hostname);
    if (!HOSTNAME_RE.test(host)) return { error: 'invalid' };
    if (!siteRuleWritable(host)) return { error: 'blocked', host };
    return { host };
  }

  /**
   * 内置名单，按「设置页怎么给人看」排好：always / captions / never 三组，每组
   * 一行一个主机，带上这个主机在表里的那几个模式（arxiv.org 只有几条路径在
   * always 上）。黑名单并进 never —— 对用户来说它们是同一件事（见 isBlocklisted）。
   *
   * 每行带 writable：那一行能不能一键写一条用户规则盖过去。never 组一律不能
   * （阶梯上它们排在用户规则前面），其余问的是 siteRuleWritable。
   */
  function builtinSites() {
    const groups = { always: new Map(), captions: new Map(), never: new Map() };
    const add = (state, pattern) => {
      const { host } = splitPattern(pattern);
      const group = groups[state];
      if (!group.has(host)) group.set(host, []);
      group.get(host).push(pattern);
    };
    for (const rule of table().rules) rulePatterns(rule).forEach((pattern) => add(rule.state, pattern));
    table().blocklist.forEach((pattern) => add('never', pattern));
    const out = {};
    for (const [state, group] of Object.entries(groups)) {
      out[state] = [...group].map(([host, patterns]) => ({
        host,
        patterns,
        writable: state !== 'never' && siteRuleWritable(host),
      }));
    }
    return out;
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
   * @param {Object}  input.userRules   { 'x.com': 'always' | 'never' }
   * @param {Object}  input.settings    { autoTranslate }
   * @param {boolean} input.explicit    用户已经在这一页表过态
   * @returns {{verdict: 'auto'|'off', reason: string, rule: ?Object,
   *            refused: boolean}} refused 见 REFUSALS：站点级的拒绝。
   *
   * 页面语言不是入参（R33 D-351）：从前谁都没替它说过话的站点要先量一次语言再
   * 「问一句」，询问条删掉之后那一档只剩一个答案 —— 不翻 —— 量语言就只是白量。
   * 「这一块已经是目标语言了」仍然逐块判，在 content/page/batch.js。
   */
  function decide(input) {
    const { host = '', path = '/', userRules, settings, explicit = false } = input || {};
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
    // 他做主，所以总开关也好、「没人替这个站点说过话」也好，都不该在这里再拦一次。
    if (explicit) return out('auto', REASONS.USER_EXPLICIT);

    if (userRule === 'always') return out('auto', REASONS.USER_ALWAYS);
    if (rule && rule.state === 'always') return out('auto', REASONS.BUILTIN_ALWAYS);
    // 字幕站：正文不翻，也不算拒绝 —— 字幕照翻。用户写过规则的，上面两级已经
    // 答完了：always 连正文一起翻，never 连字幕一起停。
    if (rule && rule.state === 'captions') return out('off', REASONS.BUILTIN_CAPTIONS);

    // 谁都没替这个站点说过话：不翻，也不问（D-351）。从前这里是一条追问条，每个
    // 外语站点问三次 —— 用户要的是「别每页都问我」。想翻的人有三个入口，都是他
    // 自己伸手：popup 的「翻译此页 / 总是翻译此网站」、悬浮球、快捷键。
    return out('off', REASONS.DEFAULT_OFF);
  }

  // ---------------------------------------------------------------- 写规则

  // 同步存储上的「读—改—写」只能有一个主人：队列、字节量法和「我在不在服务
  // 工作者里」都在 shared/storage-writer.js，三家写入共用一份（为什么要单写者
  // 也写在那边）。
  //
  // 这张表按域名一路长下去，而同步存储是**每项** 8KB：写失败了是用户刚点下的
  // 选择根本没存上。预算（StorageWriter.ITEM_BUDGET）和量法（itemBytes）与另外
  // 几家写入共用。按条数封顶只是把撑爆那天推远一点：两百个 40 字符的域名就已经
  // 贴着 8KB。
  const StorageWriter = root.StorageWriter;
  if (!StorageWriter) throw new Error('site-rules.js 要先装 shared/storage-writer.js');
  const { ITEM_BUDGET, itemBytes } = StorageWriter;

  /**
   * 站点规则满了：扔掉**扔了也不改变任何判定**的那些。
   *
   * 这张表不能挑一条扔 —— 每一条都是用户亲口说过的话，扔掉哪一条都
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
    if (itemBytes(rules) <= ITEM_BUDGET) return rules;
    const keys = Object.keys(rules)
      .filter((key) => key !== keep)
      .sort((a, b) => b.length - a.length);
    for (const key of keys) {
      const state = rules[key];
      delete rules[key];
      if (lookupUserRule(rules, key) !== state) rules[key] = state;
      else if (itemBytes(rules) <= ITEM_BUDGET) break;
    }
    return rules;
  }

  /**
   * 写下一条用户站点规则，或把它抹掉（state 不是 always/never 时）。
   *
   * 放在这里而不是几个调用方各写一遍：**存进去的那把钥匙必须和 decide() 查的
   * 那把是同一把**。popup、悬浮球、字幕菜单、设置页都要写这张表，只要有一处忘了
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
   * 设置导入：一次合并一整张表（options/options-transfer.js）。
   *
   * 和单条写入走同一条队列、同一把归一化的钥匙、同一道预算。导入的条目覆盖同名
   * 键，表里别的条目原样留着。收拾完多余条目还挤不下就抛 —— 不挑几条扔掉凑数，
   * 那是替用户改主意；也不写一半。整张表只 set 一次。
   *
   * @returns {Promise<number>} 收下的条数
   */
  async function applyImportedRules({ map }) {
    const store = root.chrome.storage.sync;
    const stored = await store.get({ siteRules: {} });
    const rules = Object.assign({}, stored.siteRules);
    let accepted = 0;
    for (const [host, state] of Object.entries(map || {})) {
      const key = normalizeHost(host);
      if (!key || !STATES.has(state)) continue;
      rules[key] = state;
      accepted += 1;
    }
    compactUserRules(rules);
    if (itemBytes(rules) > ITEM_BUDGET) {
      throw new Error(`site rules: import needs ${itemBytes(rules)} bytes, over the ${ITEM_BUDGET}-byte budget`);
    }
    await store.set({ siteRules: rules });
    return accepted;
  }

  const WRITES = { rule: applyUserRule, import: applyImportedRules };

  // applyWrite 是服务工作者的入口（背景页的消息分发只管转接，规则本身不在那边）；
  // request 在服务工作者里就自己写，在别处就把这件事交给它。用户点下的选择没存
  // 上，调用方要说得出口，所以失败照抛（'throw'）。
  const { applyWrite, request } = StorageWriter.create({
    type: 'SITE_RULES_WRITE',
    writes: WRITES,
    errors: 'throw',
  });

  function writeUserRule(hostname, state) {
    return request('rule', { host: hostname, state });
  }

  function importUserRules(map) {
    return request('import', { map });
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
   * 界面上写「这个站点自动翻」的地方都走这里 —— popup 那一行、播放器里字幕菜单
   * 的第一项、悬浮球菜单第一项。数它们没有意义，还会过期
   * （这句话上一版写的是「两个调用点」，那时已经有三个）：要紧的是那一句话只有
   * 一句，所以只该有一份实现。
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
    siteLabel,
    // 自定义规则（shared/custom-rules.js）的 match 用同一套地址写法：一种写法
    // 两份解析，迟早一个认 *.example.com 一个不认。
    hostMatches,
    patternMatches,
    validPattern,
    lookupUserRule,
    writeUserRule,
    setSiteAuto,
    applyWrite,
    matchBuiltin,
    isBlocklisted,
    siteRuleWritable,
    parseSiteInput,
    builtinSites,
    loadTable,
    importUserRules,
  };
})(globalThis);
