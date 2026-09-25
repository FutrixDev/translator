// Blab Translation — 设置导出文件的格式、校验和编排（纯函数，不碰 DOM 和 chrome.*）。
//
// 文件长这样：
//
//   { format: 'blab-settings', version: 1, exportedAt, <section>: <value>, ... }
//
// 顶层除 format / version / exportedAt 外的每个键是一个 section。有哪些 section、
// 各自怎么收集和写入，由设置页的 TRANSFER_SECTIONS 决定（options/options-transfer.js）；
// 这里只管三件对所有 section 都成立的事：
//
//   1. 先把文件里认识的 section **全部**校验完，任何一个不过就整份拒绝；
//   2. 全过了才写，按表的固定顺序一个一个写，第一个失败就停，不回滚、不吞错，
//      把哪几块写进去了、哪一块失败原样交给页面；
//   3. 文件里不认识的 section 按名字列出来，由预览告诉用户「此版本不认识，将忽略」。
//
// section 的值不一定是对象（后面会有 CSV 字符串的 section），所以这里对值的形状
// 不做任何假设，只转交。
//
// settings 这个 section 的键级校验也在这里，因为它是纯函数、要在 node 里测：
// 取值范围、排除表、枚举表、类型和格式。
(function (root) {
  'use strict';

  const FORMAT = 'blab-settings';
  const VERSION = 1;
  const META_KEYS = new Set(['format', 'version', 'exportedAt']);

  // 两张默认值表里有、但**不进** settings 的键，和不进的理由。chrome.storage.local
  // 整个不导出（缓存、统计、登录态、任务列表 —— 都不是「设置」），不在这张表里
  // 是因为这里压根不去读它。
  const EXCLUDED = Object.freeze({
    siteRules: '自己是一个 section，不在 settings 里重复',
    siteAskCount: '本机追问次数，不是用户的选择',
    youtubeCaptionPosXPct: '拖出来的设备几何，换一块屏幕就不对',
    youtubeCaptionPosYPct: '拖出来的设备几何，换一块屏幕就不对',
    youtubeCaptionWidthPct: '拖出来的设备几何，换一块屏幕就不对',
    youtubeCaptionScale: '拖出来的设备几何，换一块屏幕就不对',
  });

  // 凭证：只有用户勾了「包含 API Key」才导出。导入端照收 —— 文件里有它，说明
  // 导出的那个人明确要带上。
  const SECRET_KEYS = Object.freeze(['apiKey']);

  // 类型对了还不够的键：值要长成这样才收。
  const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
  const PATTERNS = Object.freeze({
    youtubeCaptionFontColor: HEX_COLOR,
    youtubeCaptionBgColor: HEX_COLOR,
    apiEndpoint: /^https?:\/\/\S+$/,
  });
  const RANGES = Object.freeze({
    autoAiDailyBudget: [0, Number.MAX_SAFE_INTEGER],
    youtubeCaptionBgOpacity: [0, 100],
  });
  // 数组值的元素：自动翻译的语言芯片存的是基码（SiteRules.baseLang）。
  const ARRAY_ITEMS = Object.freeze({
    autoTranslateLangs: /^[a-z]{2,3}$/,
  });

  class TransferError extends Error {
    /**
     * @param {string} code notJson | wrongFormat | wrongVersion | notObject |
     *                      nothingValid | hotkeyConflict | ...（section 自定）
     */
    constructor(code, detail) {
      super(detail ? `${code}: ${detail}` : code);
      this.name = 'TransferError';
      this.code = code;
      this.detail = detail || '';
    }
  }

  class TransferApplyError extends Error {
    constructor(written, failed, cause) {
      super(`settings import stopped at ${failed}: ${cause && cause.message}`);
      this.name = 'TransferApplyError';
      this.written = written;
      this.failed = failed;
      this.cause = cause;
    }
  }

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  /**
   * settings 能带哪些键、各自的默认值（类型以它为准）。后面的表覆盖前面的。
   */
  function settingsSchema(...defaultTables) {
    const schema = {};
    for (const table of defaultTables) Object.assign(schema, table);
    for (const key of Object.keys(EXCLUDED)) delete schema[key];
    return schema;
  }

  /**
   * 枚举表。合法值都从共享模块现取，调用方传进来，不在第二处写死。
   * 值是数组；'' 表示「跟随 / 未设」的那几个键把它列进去。
   */
  function buildEnums({ providers, uiLanguages, targetLangs, cloudTargets, styles }) {
    return {
      translationEngine: ['builtin', 'ai'],
      autoTranslateEngine: ['builtin', 'ai'],
      engineFallback: ['local-only', 'allow-ai'],
      provider: [...providers],
      selectionTranslationMode: ['inline', 'popup'],
      selectionTranslationHotkey: ['Shift', 'Alt', 'Control', 'Meta'],
      hoverTranslationHotkey: ['Shift', 'Alt', 'Control', 'Meta'],
      translationStyle: [...styles],
      pageTranslateScope: ['main', 'page'],
      captionDisplayMode: ['', 'bilingual', 'translation', 'original'],
      captionTranslationPosition: ['below', 'above'],
      ocrEngine: ['local', 'vision'],
      theme: ['light', 'dark'],
      uiLanguage: ['', ...uiLanguages],
      targetLang: ['', ...targetLangs],
      comicTargetLang: ['', ...cloudTargets],
      pdfTargetLang: ['', ...cloudTargets],
    };
  }

  /** 导出用：只取 schema 里的键；凭证默认不带。 */
  function pickExport(stored, schema, { includeApiKey }) {
    const out = {};
    for (const key of Object.keys(schema)) {
      if (!Object.prototype.hasOwnProperty.call(stored, key)) continue;
      if (SECRET_KEYS.includes(key) && !includeApiKey) continue;
      out[key] = stored[key];
    }
    return out;
  }

  function valueOk(key, value, schema, enums) {
    const fallback = schema[key];
    if (Array.isArray(fallback)) {
      const item = ARRAY_ITEMS[key];
      return Array.isArray(value) && !!item && value.every((v) => typeof v === 'string' && item.test(v));
    }
    if (fallback === null || typeof fallback === 'object') return false;
    if (typeof value !== typeof fallback) return false;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return false;
      const range = RANGES[key];
      if (range && (value < range[0] || value > range[1])) return false;
    }
    if (enums[key] && !enums[key].includes(value)) return false;
    if (PATTERNS[key] && !PATTERNS[key].test(value)) return false;
    return true;
  }

  /**
   * settings 这个 section 的键级校验。不认识的键、类型不对的、枚举外的，都丢掉
   * 并记名字。
   *
   * @returns {{value: object, accepted: number, dropped: string[]}}
   */
  function validateSettings(raw, schema, enums) {
    if (!isPlainObject(raw)) throw new TransferError('notObject', 'settings');
    const value = {};
    const dropped = [];
    for (const [key, candidate] of Object.entries(raw)) {
      const known = Object.prototype.hasOwnProperty.call(schema, key);
      if (known && valueOk(key, candidate, schema, enums)) value[key] = candidate;
      else dropped.push(key);
    }
    return { value, accepted: Object.keys(value).length, dropped };
  }

  /** 导入之后会变的键（按值比，数组按内容比）。 */
  function changedKeys(current, incoming) {
    return Object.keys(incoming)
      .filter((key) => JSON.stringify(current[key]) !== JSON.stringify(incoming[key]));
  }

  /**
   * siteRules 这个 section：{ host: 'always' | 'never' }。键按 normalizeHost 归一，
   * 归一不出键的、值不是这两个的，丢掉。
   *
   * @returns {{value: object, accepted: number, dropped: string[]}}
   */
  function validateSiteRules(raw, normalizeHost) {
    if (!isPlainObject(raw)) throw new TransferError('notObject', 'siteRules');
    const value = {};
    const dropped = [];
    for (const [host, state] of Object.entries(raw)) {
      const key = normalizeHost(host);
      if (key && (state === 'always' || state === 'never')) value[key] = state;
      else dropped.push(host);
    }
    return { value, accepted: Object.keys(value).length, dropped };
  }

  function parseFile(text) {
    let file;
    try {
      file = JSON.parse(text);
    } catch (error) {
      throw new TransferError('notJson', error.message);
    }
    if (!isPlainObject(file) || file.format !== FORMAT) throw new TransferError('wrongFormat');
    if (file.version !== VERSION) throw new TransferError('wrongVersion', String(file.version));
    return file;
  }

  function buildFile(values, now) {
    return Object.assign({ format: FORMAT, version: VERSION, exportedAt: now.toISOString() }, values);
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  /** blab-settings-YYYYMMDD.json，按本地日期。 */
  function fileName(now) {
    return `blab-settings-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.json`;
  }

  /**
   * 先全部校验。文件里没有的 section 跳过；有但校验抛错的，整份拒绝；全部加起来
   * 一条都没收下，也拒绝 —— 「导入成功」却什么都没变，比报错更让人困惑。
   *
   * @returns {Promise<{sections: Array<{key, value, accepted, dropped}>, unknown: string[]}>}
   */
  async function validateAll(file, sections) {
    const known = new Set(sections.map((section) => section.key));
    const unknown = Object.keys(file).filter((key) => !META_KEYS.has(key) && !known.has(key));
    const results = [];
    for (const section of sections) {
      if (!Object.prototype.hasOwnProperty.call(file, section.key)) continue;
      const result = await section.validate(file[section.key]);
      results.push(Object.assign({ key: section.key }, result));
    }
    if (results.every((result) => result.accepted === 0)) throw new TransferError('nothingValid');
    return { sections: results, unknown };
  }

  /**
   * 按表的顺序写。第一个失败就停，抛 TransferApplyError：written 是已经写进去的
   * section，failed 是失败的那个。不回滚 —— 回滚本身也会失败，而且会把用户已经
   * 看到生效的东西再悄悄撤掉；如实说出哪几块进去了，比假装原子更诚实。
   *
   * @returns {Promise<string[]>} 写入的 section
   */
  async function applyAll(validated, sections) {
    const byKey = new Map(validated.sections.map((result) => [result.key, result]));
    const written = [];
    for (const section of sections) {
      const result = byKey.get(section.key);
      if (!result || result.accepted === 0) continue;
      try {
        await section.apply(result.value);
      } catch (error) {
        throw new TransferApplyError(written, section.key, error);
      }
      written.push(section.key);
    }
    return written;
  }

  root.SettingsTransfer = {
    FORMAT,
    VERSION,
    EXCLUDED,
    SECRET_KEYS,
    TransferError,
    TransferApplyError,
    settingsSchema,
    buildEnums,
    pickExport,
    validateSettings,
    changedKeys,
    validateSiteRules,
    parseFile,
    buildFile,
    fileName,
    validateAll,
    applyAll,
  };
})(globalThis);
