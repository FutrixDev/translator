/**
 * 用户术语表：这个词译成什么，或者别译。
 *
 * 双模经典脚本：服务工作者 import 它，内容脚本、设置页用 <script> 装，挂在
 * globalThis.Glossary 上。popup 不加载。
 *
 * 存储是 `glossary:<id>` 一条一个 sync 键，读、写、缓存、增量、额度全部来自
 * SyncCollection（shared/sync-collection.js）—— 这里只给它参数，外加词条本身的
 * 语义：形状校验、哪两条算同一条（dedupeKey）、同一原文命中多条时谁胜出
 * （pick）、三种写入。
 *
 * 词条的形状（v 缺省即 1；读到 v > 1 的跳过）：
 *   { s: 原文 1–80 字, t?: 译文 ≤ 160 字（缺省 = 保留原文）, c?: 1 区分大小写,
 *     h?: 站点（normalizeHost 之后）, l: 目标语言或 '*', u: 最后修改时间 }
 * id 只在键里（集合负责）。
 *
 * CSV 的格式与导入合并在 shared/glossary-csv.js（GlossaryCsv）。
 *
 * 抛出的错误一律是 i18n 键（见 ERROR_KEYS）；写入时别的失败统一成
 * glossarySaveFailed，并在变成这个键的那一处记一条日志。
 */
(function (root) {
  'use strict';

  const SiteRules = root.SiteRules;
  if (!SiteRules) throw new Error('glossary.js 要先装 shared/site-rules.js');
  const StorageWriter = root.StorageWriter;
  if (!StorageWriter) throw new Error('glossary.js 要先装 shared/storage-writer.js');
  const SyncCollection = root.SyncCollection;
  if (!SyncCollection) throw new Error('glossary.js 要先装 shared/sync-collection.js');
  const TargetLang = root.TargetLang;
  if (!TargetLang) throw new Error('glossary.js 要先装 shared/target-lang.js');

  const KEY_PREFIX = 'glossary:';
  const VERSION = 1;
  const ANY_LANG = '*';

  const LIMITS = Object.freeze({
    source: 80,
    target: 160,
    itemBytes: 1024,
    totalBytes: 32 * 1024,
    maxItems: 300,
  });

  const ERROR_KEYS = new Set([
    'glossaryEntryInvalid',
    'glossaryEntryTooLarge',
    'glossaryBudgetFull',
    'glossaryDuplicate',
    'glossaryImportInvalid',
  ]);

  // 词条上认得的字段；id 是写入口带来的（put 按它替换），不进值。
  const FIELDS = new Set(['v', 's', 't', 'c', 'h', 'l', 'u', 'id']);

  function invalid() {
    return new Error('glossaryEntryInvalid');
  }

  // ------------------------------------------------------------ 形状校验

  /** NFC、去首尾空白、内部空白压成一个空格。表单、CSV、匹配器用同一个。 */
  function normalizeSource(s) {
    return String(s == null ? '' : s).normalize('NFC').trim().replace(/\s+/g, ' ');
  }

  /** 添加词条时「区分大小写」的缺省：原文含大写字母就区分（设置页表单、划词卡片共用）。 */
  function caseSensitiveByDefault(s) {
    return /\p{Lu}/u.test(s);
  }

  function isPresent(value) {
    return value !== undefined && value !== null && value !== '';
  }

  function normalizeCase(c) {
    if (c === 1 || c === true) return 1;
    if (c === undefined || c === null || c === 0 || c === false) return 0;
    throw invalid();
  }

  function normalizeSite(h) {
    if (typeof h !== 'string') throw invalid();
    const host = SiteRules.normalizeHost(h);
    if (!host || /[\s/:]/.test(host)) throw invalid();
    return host;
  }

  function normalizeLang(l) {
    if (l === undefined || l === null || l === '' || l === ANY_LANG) return ANY_LANG;
    if (typeof l !== 'string' || !TargetLang.SUPPORTED.includes(l)) throw invalid();
    return l;
  }

  /**
   * 返回规范化后的词条（不带 id），或抛 glossaryEntryInvalid。写入口和读出来的
   * 条目（decode）都走这里：词条没有「只查形状的一半」之外的检查。
   * 缺省的 l 记成 '*' 并总是存下；空的 t 等于没写（保留原文）。
   */
  function validateEntry(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw invalid();
    for (const key of Object.keys(entry)) {
      if (!FIELDS.has(key)) throw invalid();
    }
    if (entry.v !== undefined && entry.v !== VERSION) throw invalid();
    if (typeof entry.s !== 'string') throw invalid();
    const s = normalizeSource(entry.s);
    if (!s || s.length > LIMITS.source) throw invalid();

    const out = { s };
    if (isPresent(entry.t)) {
      if (typeof entry.t !== 'string') throw invalid();
      const t = entry.t.normalize('NFC').trim();
      if (t.length > LIMITS.target) throw invalid();
      if (t) out.t = t;
    }
    if (normalizeCase(entry.c)) out.c = 1;
    if (isPresent(entry.h)) out.h = normalizeSite(entry.h);
    out.l = normalizeLang(entry.l);
    // 和 v 一样：写了就得是对的。坏的 u 不能悄悄丢掉 —— outranks 靠它分新旧。
    if (entry.u !== undefined) {
      if (!Number.isFinite(entry.u)) throw invalid();
      out.u = entry.u;
    }
    return out;
  }

  // 存储里的一项 -> 词条，或 null：不认识的版本（v > 1）、坏条目都跳过（集合只
  // 记数目）。这里是 validateEntry 被接住的那一层，错误变成「跳过」，日志由集合打。
  function decode(value) {
    if (!value || typeof value !== 'object') return null;
    if (value.v !== undefined && value.v !== VERSION) return null;
    try {
      return validateEntry(value);
    } catch (error) {
      return null;
    }
  }

  const collection = SyncCollection.create({
    prefix: KEY_PREFIX,
    decode,
    hosts: (entry) => (entry.h ? [entry.h] : []),
    limits: { itemBytes: LIMITS.itemBytes, totalBytes: LIMITS.totalBytes, maxItems: LIMITS.maxItems },
    errors: { tooLarge: 'glossaryEntryTooLarge', budgetFull: 'glossaryBudgetFull' },
  });

  /** 同一个键就是同一条：大小写口径、原文、站点、目标语言。 */
  function dedupeKey(entry) {
    const s = normalizeSource(entry.s);
    return `${entry.c ? 'c' : 'i'}:${entry.c ? s : s.toLowerCase()}|${entry.h || '*'}|${entry.l || ANY_LANG}`;
  }

  // ------------------------------------------------------------ 胜出词条

  // 越具体越靠前（§0.1-5）：站点 > 全局（站点里更长的主机更具体）、指定语言 >
  // 所有语言、区分大小写 > 不区分、新 > 旧；再一样取 id 较小的，顺序才稳定。
  function outranks(a, b) {
    const keys = [
      (e) => (e.h ? e.h.length : 0),
      (e) => (e.l !== ANY_LANG ? 1 : 0),
      (e) => (e.c ? 1 : 0),
      (e) => e.u || 0,
    ];
    for (const key of keys) {
      const diff = key(a) - key(b);
      if (diff) return diff > 0;
    }
    return a.id < b.id;
  }

  // 两条争的是不是同一段文字：不分大小写相等才可能；两条都区分大小写而原文
  // 不逐字相等（Apple / apple）时各管各的。
  function competes(a, b) {
    const x = normalizeSource(a.s);
    const y = normalizeSource(b.s);
    if (x.toLowerCase() !== y.toLowerCase()) return false;
    return !(a.c && b.c && x !== y);
  }

  /**
   * 这个主机、这门目标语言上生效的词条，按优先级排好。作用域过滤是 forHost
   * （站点后缀匹配）加 l 等于目标语言或 '*'；同一原文命中多条时只留胜者。
   */
  function pick(entries, host, targetLang) {
    const scoped = collection.forHost(entries || [], host)
      .filter((entry) => entry.l === ANY_LANG || entry.l === targetLang);
    const ranked = scoped.slice().sort((a, b) => (outranks(a, b) ? -1 : outranks(b, a) ? 1 : 0));
    const kept = [];
    for (const entry of ranked) {
      if (!kept.some((winner) => competes(winner, entry))) kept.push(entry);
    }
    return kept;
  }

  // ------------------------------------------------------------ 写入（SW）

  function checkedId(id) {
    if (!collection.validId(id)) throw invalid();
    return id;
  }

  // scope: 'site' 的站点取发信那个 tab 的顶层地址，不信载荷里的 h（修-A）。
  function senderSite(sender) {
    const url = sender && sender.tab && sender.tab.url;
    if (!url) throw invalid();
    let hostname;
    try {
      hostname = new URL(url).hostname;
    } catch (error) {
      throw invalid();
    }
    return normalizeSite(hostname);
  }

  // 无 id：同一个 dedupeKey 的那条就替换，没有就新增。有 id：替换那一条（不存在
  // 就以这个 id 新增）；改完和另一条撞 dedupeKey 就拒绝，存储不动。
  function writePut({ entry, scope }, sender) {
    if (scope !== undefined && scope !== 'site') throw invalid();
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw invalid();
    const source = scope === 'site' ? Object.assign({}, entry, { h: senderSite(sender) }) : entry;
    const normalized = validateEntry(source);
    const wantedId = entry.id === undefined ? undefined : checkedId(entry.id);
    const key = dedupeKey(normalized);
    return collection.write((entries) => {
      normalized.u = Date.now();
      if (wantedId !== undefined) {
        if (entries.some((other) => other.id !== wantedId && dedupeKey(other) === key)) {
          throw new Error('glossaryDuplicate');
        }
        normalized.id = wantedId;
        return { put: [normalized], result: { id: wantedId, replaced: entries.some((e) => e.id === wantedId) } };
      }
      const same = entries.find((other) => dedupeKey(other) === key);
      normalized.id = same ? same.id : collection.newId();
      return { put: [normalized], result: { id: normalized.id, replaced: Boolean(same) } };
    });
  }

  function writeRemove({ ids }) {
    if (!Array.isArray(ids) || !ids.length || ids.length > LIMITS.maxItems) throw invalid();
    const unique = Array.from(new Set(ids.map(checkedId)));
    return collection.write((entries) => {
      const present = new Set(entries.map((entry) => entry.id));
      return { remove: unique, result: { removed: unique.filter((id) => present.has(id)).length } };
    });
  }

  // 解析、校验、合并、额度都在 GlossaryCsv.mergeImport 一处（设置页的预览也走
  // 它）。GlossaryCsv 在调用时才取：它加载时要先有 Glossary，而内容脚本和首装
  // 引导页只装 glossary.js、不装 CSV。只写文件动过的条目，u 取这一刻。
  function writeImport({ csv }) {
    const GlossaryCsv = root.GlossaryCsv;
    if (!GlossaryCsv) throw new Error('Glossary import needs shared/glossary-csv.js');
    if (typeof csv !== 'string') throw new Error('glossaryImportInvalid');
    return collection.write((entries) => {
      const { entries: merged, added, replaced } = GlossaryCsv.mergeImport(entries, csv, Date.now());
      const untouched = new Set(entries);
      return { put: merged.filter((entry) => !untouched.has(entry)), result: { added, replaced } };
    });
  }

  // 已知的错误键原样往上走；别的（存储失败、意外）在这里变成 glossarySaveFailed
  // —— 原始错误在这一层被接住，所以在这一层记日志（不带词条内容）。
  function saveError(kind, error) {
    if (error && ERROR_KEYS.has(error.message)) throw error;
    console.error(`Glossary ${kind} write failed:`, error);
    throw new Error('glossarySaveFailed');
  }

  /** 界面拿到一个错误时能直接查文案的键；别的一律 null。 */
  function userErrorKey(error) {
    const key = error && error.message;
    return ERROR_KEYS.has(key) || key === 'glossarySaveFailed' ? key : null;
  }

  function guarded(kind, write) {
    return (message, sender) => Promise.resolve()
      .then(() => write(message, sender))
      .catch((error) => saveError(kind, error));
  }

  const WRITES = {
    put: guarded('put', writePut),
    remove: guarded('remove', writeRemove),
    import: guarded('import', writeImport),
  };

  const { applyWrite, request } = StorageWriter.create({
    type: 'GLOSSARY_WRITE',
    writes: WRITES,
    errors: 'throw',
  });

  root.Glossary = {
    KEY_PREFIX,
    LIMITS,
    ANY_LANG,
    ERROR_KEYS,
    userErrorKey,
    newId: collection.newId,
    normalizeSource,
    caseSensitiveByDefault,
    dedupeKey,
    validateEntry,
    pick,
    collect: collection.collect,
    forHost: collection.forHost,
    applyChanges: collection.applyChanges,
    usage: collection.usage,
    assertFits: collection.assertFits,
    merge: collection.merge,
    applyWrite,
    request,
    cached: collection.cached,
    mirror: collection.mirror,
  };
})(globalThis);
