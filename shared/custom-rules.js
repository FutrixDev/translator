/**
 * 用户站点规则：这个站点翻哪一块、哪一块别碰、保留哪些原文、加什么 CSS、用哪个
 * 引擎。
 *
 * 双模经典脚本：服务工作者 import 它，内容脚本、设置页用 <script> 装，挂在
 * globalThis.CustomRules 上。popup 不加载。
 *
 * 存储是 `customRule:<id>` 一条一个 sync 键，读、写、缓存、增量全部来自
 * SyncCollection（shared/sync-collection.js）—— 这里只给它参数，外加规则本身
 * 的语义：形状校验、CSS 清洗、同一 URL 命中多条时谁胜出、导入导出的文件格式、
 * 四种写入。这个文件里不挂 storage 监听、不 get(null)、不去抖：那些只在集合里
 * 有一份，sync-collection 的单测会扫。
 *
 * 规则的形状（v1）：
 *   { v: 1, match: [...1–8 条 host[/path-glob]], include?, exclude?,
 *     keepOriginal?, css?, engine?: 'builtin'|'ai', updatedAt }
 * id 只在键里（集合负责），空的选择器组不存。
 *
 * 抛出的错误一律是 i18n 键（见 ERROR_KEYS），界面直接拿去查文案；写入时别的
 * 失败统一成 customRuleSaveFailed，并在变成这个键的那一处记一条日志。
 */
(function (root) {
  'use strict';

  const SiteRules = root.SiteRules;
  if (!SiteRules) throw new Error('custom-rules.js 要先装 shared/site-rules.js');
  const StorageWriter = root.StorageWriter;
  if (!StorageWriter) throw new Error('custom-rules.js 要先装 shared/storage-writer.js');
  const SyncCollection = root.SyncCollection;
  if (!SyncCollection) throw new Error('custom-rules.js 要先装 shared/sync-collection.js');

  const KEY_PREFIX = 'customRule:';
  const VERSION = 1;
  const FILE_FORMAT = 'blab-site-rules';
  const FILE_VERSION = 1;

  // 单条的字节上限就是同步存储的单项预算，不另起一个数。
  const LIMITS = Object.freeze({
    ruleBytes: StorageWriter.ITEM_BUDGET,
    totalBytes: 24 * 1024,
    maxRules: 50,
    maxPatterns: 8,
    maxSelectors: 50,
    maxSelectorLength: 500,
    maxCss: 4096,
  });

  const SELECTOR_FIELDS = Object.freeze(['include', 'exclude', 'keepOriginal']);
  const ENGINES = new Set(['builtin', 'ai']);

  const ERROR_KEYS = new Set([
    'customRuleInvalid',
    'customRuleCssUnsafe',
    'customRuleMatchInvalid',
    'customRuleSelectorInvalid',
    'customRuleTooLarge',
    'customRulesBudgetFull',
    'customRulesImportInvalid',
  ]);

  // ------------------------------------------------------------ CSS 清洗

  // 能发请求的写法：取图、取字体、引外部表、拿属性值拼地址。反斜杠转义能把
  // 这些关键字拼出来（u\72l(），所以一律拒。
  const UNSAFE_CSS = [
    /url\s*\(/i,
    /image-set\s*\(/i,
    /image\s*\(/i,
    /cross-fade\s*\(/i,
    /src\s*\(/i,
    /attr\s*\(/i,
    /@import/i,
    /@font-face/i,
    /\\/,
  ];

  /**
   * 返回原文本（只拒不改：用户看到的就是生效的），或抛 customRuleCssUnsafe。
   *
   * 原文和去掉注释后的文本各查一遍，任一命中就拒，注释里出现的也算：
   *   - 原文这一遍兜住字符串。按 CSS 的分词规则，字符串对注释不透明：
   *     `content: "/＊"` 里的 `/＊` 不开注释，而去注释的正则不认字符串，会从那里
   *     一直吞到下一个 `＊/` 或文本末尾，把中间真正生效的 `url(` 一起吞掉。反斜杠
   *     转义已经整个禁了，所以任何活的 `url(` 或 at-rule 在原文里一定是连着写的，
   *     原文这一遍一定看得见它；
   *   - 去注释这一遍兜住拼接：`u/＊＊/rl(` 在原文里不连着，去掉注释才连上。
   * 宁可多拒：注释里写了 `url(` 的 CSS 也拒，不给注释开例外。
   */
  function sanitizeCss(css) {
    const text = String(css == null ? '' : css);
    if (text.length > LIMITS.maxCss) throw new Error('customRuleCssUnsafe');
    const bare = text.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, '');
    if (UNSAFE_CSS.some((re) => re.test(text) || re.test(bare))) throw new Error('customRuleCssUnsafe');
    return text;
  }

  // ------------------------------------------------------------ 形状校验

  // 'WWW.Example.com./guide/*' -> 'example.com/guide/*'：主机部分和站点规则的键
  // 同一个口径（SiteRules.normalizeHost），路径原样。
  function normalizePattern(pattern) {
    if (!SiteRules.validPattern(pattern)) return null;
    const raw = pattern.trim();
    const slash = raw.indexOf('/');
    const host = SiteRules.normalizeHost(slash === -1 ? raw : raw.slice(0, slash));
    if (!host || /\s/.test(host)) return null;
    return slash === -1 ? host : host + raw.slice(slash);
  }

  function patternHost(pattern) {
    return pattern.split('/')[0];
  }

  function normalizeSelectors(list, checkSelector) {
    if (list == null) return [];
    if (!Array.isArray(list) || list.length > LIMITS.maxSelectors) throw new Error('customRuleSelectorInvalid');
    const out = [];
    for (const item of list) {
      if (typeof item !== 'string') throw new Error('customRuleSelectorInvalid');
      const selector = item.trim();
      if (!selector || selector.length > LIMITS.maxSelectorLength) throw new Error('customRuleSelectorInvalid');
      if (checkSelector && !checkSelector(selector)) throw new Error('customRuleSelectorInvalid');
      if (!out.includes(selector)) out.push(selector);
    }
    return out;
  }

  /**
   * 返回规范化后的规则（不带 id，未知字段丢掉），或抛 Error(<i18n 键>)。
   * 写入口（设置页、导入、拾取器、SW 的 CUSTOM_RULES_WRITE）都走这里，CSS 要过
   * 清洗。
   *
   * @param {Object} rule
   * @param {{checkSelector?: function(string): boolean}} [options]
   *   checkSelector：选择器语法只能在有 DOM 的地方查，设置页和拾取器传进来；
   *   SW 只查形状和长度。
   */
  function validateRule(rule, options) {
    const out = normalizeRule(rule, options && options.checkSelector);
    if (out.css) sanitizeCss(out.css);
    return out;
  }

  /**
   * validateRule 只查形状的那一半：CSS 只要求是不超长的字符串，不清洗。存储里
   * 读出来的条目（decode）走这一半 —— 绕过写入口写进去的不安全 CSS 不该让整条
   * 规则作废，它由内容侧挂载前的清洗拒掉，规则的其余字段照常生效（设计 §3.5）。
   */
  function normalizeRule(rule, checkSelector) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error('customRuleInvalid');
    if (rule.v !== undefined && rule.v !== VERSION) throw new Error('customRuleInvalid');

    const match = rule.match;
    if (!Array.isArray(match) || !match.length || match.length > LIMITS.maxPatterns) {
      throw new Error('customRuleMatchInvalid');
    }
    const patterns = [];
    for (const pattern of match) {
      const normalized = normalizePattern(pattern);
      if (!normalized) throw new Error('customRuleMatchInvalid');
      if (!patterns.includes(normalized)) patterns.push(normalized);
    }

    const out = { v: VERSION, match: patterns };
    for (const field of SELECTOR_FIELDS) {
      const selectors = normalizeSelectors(rule[field], checkSelector);
      if (selectors.length) out[field] = selectors;
    }
    if (rule.css != null && rule.css !== '') {
      if (typeof rule.css !== 'string' || rule.css.length > LIMITS.maxCss) throw new Error('customRuleCssUnsafe');
      if (rule.css.trim()) out.css = rule.css;
    }
    if (rule.engine != null && rule.engine !== '') {
      if (!ENGINES.has(rule.engine)) throw new Error('customRuleInvalid');
      out.engine = rule.engine;
    }
    if (!SELECTOR_FIELDS.some((field) => out[field]) && !out.css && !out.engine) {
      throw new Error('customRuleInvalid');
    }
    if (Number.isFinite(rule.updatedAt)) out.updatedAt = rule.updatedAt;
    return out;
  }

  // 存储里的一项 -> 规则，或 null：不认识的版本、坏条目都跳过（集合只记数目）。
  // 这里是 normalizeRule 被接住的那一层，错误变成「跳过」，日志由集合打。
  function decode(value) {
    if (!value || value.v !== VERSION) return null;
    try {
      return normalizeRule(value, null);
    } catch (error) {
      return null;
    }
  }

  const collection = SyncCollection.create({
    prefix: KEY_PREFIX,
    decode,
    hosts: (rule) => rule.match.map(patternHost),
    limits: { itemBytes: LIMITS.ruleBytes, totalBytes: LIMITS.totalBytes, maxItems: LIMITS.maxRules },
    errors: { tooLarge: 'customRuleTooLarge', budgetFull: 'customRulesBudgetFull' },
  });

  // ------------------------------------------------------------ 胜出规则

  // 这条规则在这个 URL 上命中的最长模式串的长度；不命中为 -1。
  function matchLength(rule, host, path) {
    let best = -1;
    for (const pattern of rule.match) {
      if (pattern.length > best && SiteRules.patternMatches(pattern, host, path)) best = pattern.length;
    }
    return best;
  }

  /**
   * 同一 URL 命中多条时只取一条，不叠加：命中的模式串最长者胜；一样长取
   * updatedAt 较新的；再一样取 id 较小的。没有命中返回 null。
   */
  function pick(rules, host, path) {
    let winner = null;
    let winnerLength = -1;
    for (const rule of rules || []) {
      const length = matchLength(rule, host, path);
      if (length < 0) continue;
      if (!winner || length > winnerLength) {
        winner = rule;
        winnerLength = length;
        continue;
      }
      if (length < winnerLength) continue;
      const a = rule.updatedAt || 0;
      const b = winner.updatedAt || 0;
      if (a > b || (a === b && rule.id < winner.id)) winner = rule;
    }
    return winner;
  }

  // ------------------------------------------------------------ 导入导出

  function importInvalid(cause) {
    return cause === undefined
      ? new Error('customRulesImportInvalid')
      : new Error('customRulesImportInvalid', { cause });
  }

  /**
   * 文件（已解析的对象）并进现有规则：按 id 合并，全有或全无；额度按合并后的
   * 结果查；导入的规则 updatedAt 一律记为现在。
   *
   * @returns {{rules: Object[], added: number, replaced: number, aiCount: number}}
   *   aiCount：文件里 engine 为 'ai' 的条数，给预览里的「会花钱」提示。
   */
  function mergeImport(existing, file, options) {
    if (!file || typeof file !== 'object' || file.format !== FILE_FORMAT || file.version !== FILE_VERSION
      || !Array.isArray(file.rules)) {
      throw importInvalid();
    }
    const now = Date.now();
    const seen = new Set();
    const incoming = file.rules.map((raw) => {
      let rule;
      try {
        rule = validateRule(raw, options);
      } catch (error) {
        throw importInvalid(error);
      }
      const id = raw.id;
      if (id !== undefined) {
        // 同一个 id 在文件里出现两次，「替换了几条」就说不清了。
        if (!collection.validId(id) || seen.has(id)) throw importInvalid(new Error('customRuleInvalid'));
        seen.add(id);
        rule.id = id;
      }
      rule.updatedAt = now;
      return rule;
    });
    const merged = collection.merge(existing, incoming, (rule) => rule.id);
    collection.assertFits(merged.entries);
    return {
      rules: merged.entries,
      added: merged.added,
      replaced: merged.replaced,
      aiCount: incoming.filter((rule) => rule.engine === 'ai').length,
    };
  }

  // 文件里每条规则带 id（集合从键上取回来的那个），id 排在最前面好读。
  function toExportFile(rules) {
    return {
      format: FILE_FORMAT,
      version: FILE_VERSION,
      exportedAt: Date.now(),
      rules: (rules || []).map((rule) => Object.assign({ id: rule.id }, rule)),
    };
  }

  // ------------------------------------------------------------ 写入（SW）

  function checkedId(id) {
    if (!collection.validId(id)) throw new Error('customRuleInvalid');
    return id;
  }

  // 新增，或整条替换同 id 的规则。
  function writePut({ rule }) {
    return collection.write(() => {
      const id = rule && rule.id !== undefined ? checkedId(rule.id) : collection.newId();
      const normalized = validateRule(rule);
      normalized.updatedAt = Date.now();
      normalized.id = id;
      return { put: [normalized], result: { id } };
    });
  }

  function writeRemove({ id }) {
    checkedId(id);
    return collection.write(() => ({ remove: [id] }));
  }

  function writeImport({ file }) {
    return collection.write((entries) => {
      const { rules, added, replaced } = mergeImport(entries, file);
      // 没被文件动过的条目还是原来那个对象；新增和替换的都是新对象。
      const untouched = new Set(entries);
      return { put: rules.filter((rule) => !untouched.has(rule)), result: { added, replaced } };
    });
  }

  // 拾取器的一下：追加到这个 URL 的胜出规则里（已有不重复）；没有胜出规则就
  // 新建一条只认这台主机的。
  function writeAddSelector({ host, path, field, selector }) {
    if (!SELECTOR_FIELDS.includes(field)) throw new Error('customRuleInvalid');
    if (typeof selector !== 'string' || !selector.trim()) throw new Error('customRuleSelectorInvalid');
    const key = SiteRules.normalizeHost(host);
    if (!key) throw new Error('customRuleMatchInvalid');
    const wanted = selector.trim();
    return collection.write((entries) => {
      const winner = pick(entries, key, path);
      if (winner) {
        const list = winner[field] || [];
        if (list.includes(wanted)) return { result: { id: winner.id } };
        const updated = validateRule(Object.assign({}, winner, { [field]: list.concat(wanted) }));
        updated.updatedAt = Date.now();
        updated.id = winner.id;
        return { put: [updated], result: { id: winner.id } };
      }
      const created = validateRule({ match: [key], [field]: [wanted] });
      created.updatedAt = Date.now();
      created.id = collection.newId();
      return { put: [created], result: { id: created.id } };
    });
  }

  // 已知的错误键原样往上走；别的（存储失败、配额之外的意外）在这里变成
  // customRuleSaveFailed —— 原始错误在这一层被接住，所以在这一层记日志。
  function saveError(kind, error) {
    if (error && ERROR_KEYS.has(error.message)) throw error;
    console.error(`CustomRules ${kind} write failed:`, error);
    throw new Error('customRuleSaveFailed');
  }

  function guarded(kind, write) {
    return (message) => Promise.resolve()
      .then(() => write(message))
      .catch((error) => saveError(kind, error));
  }

  const WRITES = {
    put: guarded('put', writePut),
    remove: guarded('remove', writeRemove),
    import: guarded('import', writeImport),
    addSelector: guarded('addSelector', writeAddSelector),
  };

  // applyWrite 是服务工作者的入口（背景页的分派表只管转接）；request 在服务工作
  // 者里就自己写，在别处就交给它。用户刚点下的保存没存上，调用方要说得出口，
  // 所以失败照抛（'throw'）。
  const { applyWrite, request } = StorageWriter.create({
    type: 'CUSTOM_RULES_WRITE',
    writes: WRITES,
    errors: 'throw',
  });

  root.CustomRules = {
    KEY_PREFIX,
    LIMITS,
    SELECTOR_FIELDS,
    newId: collection.newId,
    validateRule,
    sanitizeCss,
    collect: collection.collect,
    forHost: collection.forHost,
    pick,
    applyChanges: collection.applyChanges,
    usage: collection.usage,
    assertFits: collection.assertFits,
    mergeImport,
    toExportFile,
    applyWrite,
    request,
    cached: collection.cached,
    mirror: collection.mirror,
  };
})(globalThis);
