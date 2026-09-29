/**
 * AI 配置档：发给哪个模型服务、用哪把 Key、哪个模型，按功能、按站点选档。
 *
 * 双模经典脚本：服务工作者 import 它，内容脚本、设置页、引导页用 <script> 装，
 * 挂在 globalThis.AIProfiles 上。popup 不加载（它问页面或 SW，设计 §3.5）。
 *
 * 存储是 `aiProfile:<id>` 一条一个 sync 键，读、写、缓存、增量、额度全部来自
 * SyncCollection（shared/sync-collection.js）—— 这里只给它参数，外加配置档本身
 * 的语义：形状校验、集合规则（恰好一个默认档、一个功能至多一档）、选档、给内容
 * 脚本的公开形状、旧四键的转换、四种写入。这个文件里不挂 storage 监听、不
 * get(null)、不去抖：那些只在集合里有一份，sync-collection 的单测会扫。
 *
 * 配置档的形状（v 必须是 1；读到别的版本跳过）：
 *   { v: 1, name: 1–40 字, provider: APICompat.PROVIDERS 的键（含 'custom'）,
 *     apiEndpoint: ≤ 512 的 http(s) 地址, apiKey: ≤ 1024（可以为空）,
 *     modelName: 1–128 字, features: FEATURES 的子集, default: 布尔,
 *     rpm: 0–600, concurrency: 0–32, timeoutSec: 15–240, updatedAt }
 * id 只在键里（集合负责）；旧配置迁来的那一档固定是 `aiProfile:legacy`。
 * 未知字段写入时丢掉。
 *
 * 抛出的错误一律是 i18n 键（见 ERROR_KEYS）；写入时别的失败统一成
 * aiProfileSaveFailed，并在变成这个键的那一处记一条日志（不带 Key）。
 */
(function (root) {
  'use strict';

  const StorageWriter = root.StorageWriter;
  if (!StorageWriter) throw new Error('ai-profiles.js 要先装 shared/storage-writer.js');
  const SyncCollection = root.SyncCollection;
  if (!SyncCollection) throw new Error('ai-profiles.js 要先装 shared/sync-collection.js');
  const APICompat = root.APICompat;
  if (!APICompat) throw new Error('ai-profiles.js 要先装 shared/api-compat.js');

  const KEY_PREFIX = 'aiProfile:';
  const VERSION = 1;
  const LEGACY_ID = 'legacy';

  // 请求标明的功能。设置页的分配表、请求字面量的扫描都读这一份。
  const FEATURES = Object.freeze(['page', 'selection', 'hover', 'input', 'subtitles', 'ocr']);

  // 迁移前的四个全局设置键（设计 §2.6）。只在迁移和整份导入的旧文件转换里出现。
  const LEGACY_KEYS = Object.freeze(['provider', 'apiEndpoint', 'apiKey', 'modelName']);

  const LIMITS = Object.freeze({
    name: 40,
    endpoint: 512,
    key: 1024,
    model: 128,
    rpm: 600,
    concurrency: 32,
    timeoutMin: 15,
    timeoutMax: 240,
    itemBytes: 2560,
    totalBytes: 8192,
    maxItems: 20,
  });

  const DEFAULT_TIMEOUT_SEC = 120;
  const OPENAI = APICompat.PROVIDERS.openai;

  // 新建表单的初值：迁移前 background/settings.js 的四个缺省值加上超时。只用来
  // 填表，不是缺省配置 —— 没有配置档就是没有配置档。
  const DRAFT = Object.freeze({
    provider: 'openai',
    apiEndpoint: OPENAI.endpoint,
    apiKey: '',
    modelName: OPENAI.defaultModel,
    timeoutSec: DEFAULT_TIMEOUT_SEC,
  });

  const ERROR_KEYS = new Set([
    'aiProfileInvalid',
    'aiProfileTooLarge',
    'aiProfilesBudgetFull',
    'aiProfileInUse',
    'aiProfileDefaultInUse',
  ]);

  function invalid() {
    return new Error('aiProfileInvalid');
  }

  // ------------------------------------------------------------ 形状校验

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function trimmedString(value, min, max) {
    if (typeof value !== 'string') throw invalid();
    const text = value.trim();
    if (text.length < min || text.length > max) throw invalid();
    return text;
  }

  function endpointOf(value) {
    const text = trimmedString(value, 1, LIMITS.endpoint);
    let url;
    try {
      url = new URL(text);
    } catch (error) {
      throw invalid();
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalid();
    return text;
  }

  // 缺省（undefined）取 fallback；写了就得是范围内的整数。
  function integerOf(value, min, max, fallback) {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value < min || value > max) throw invalid();
    return value;
  }

  // FEATURES 的子集，去重，按 FEATURES 的顺序排。
  function featuresOf(value) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((feature) => !FEATURES.includes(feature))) throw invalid();
    return FEATURES.filter((feature) => value.includes(feature));
  }

  /**
   * 返回规范化后的配置档（不带 id），或抛 aiProfileInvalid。写入口和读出来的
   * 条目（decode）都走这里。未知字段丢掉；缺省的 rpm / concurrency / timeoutSec
   * 取 0 / 0 / 120，缺省的 apiKey 是空串，缺省的 default 是 false。
   */
  function normalize(profile) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw invalid();
    if (profile.v !== undefined && profile.v !== VERSION) throw invalid();
    if (typeof profile.provider !== 'string' || !hasOwn(APICompat.PROVIDERS, profile.provider)) throw invalid();
    const apiKey = profile.apiKey === undefined ? '' : profile.apiKey;
    if (typeof apiKey !== 'string' || apiKey.trim().length > LIMITS.key) throw invalid();
    if (profile.default !== undefined && typeof profile.default !== 'boolean') throw invalid();
    const out = {
      v: VERSION,
      name: trimmedString(profile.name, 1, LIMITS.name),
      provider: profile.provider,
      apiEndpoint: endpointOf(profile.apiEndpoint),
      apiKey: apiKey.trim(),
      modelName: trimmedString(profile.modelName, 1, LIMITS.model),
      features: featuresOf(profile.features),
      default: profile.default === true,
      rpm: integerOf(profile.rpm, 0, LIMITS.rpm, 0),
      concurrency: integerOf(profile.concurrency, 0, LIMITS.concurrency, 0),
      timeoutSec: integerOf(profile.timeoutSec, LIMITS.timeoutMin, LIMITS.timeoutMax, DEFAULT_TIMEOUT_SEC),
    };
    if (profile.updatedAt !== undefined) {
      if (!Number.isFinite(profile.updatedAt)) throw invalid();
      out.updatedAt = profile.updatedAt;
    }
    return out;
  }

  /** 形状与长度；返回 i18n 键或 null。 */
  function validate(profile) {
    try {
      normalize(profile);
      return null;
    } catch (error) {
      return error.message;
    }
  }

  /**
   * 集合规则：恰好一个默认档（集合为空时例外）；每个功能至多出现在一档里。
   * 返回 i18n 键或 null。
   */
  function validateSet(profiles) {
    const list = profiles || [];
    if (!list.length) return null;
    if (list.filter((profile) => profile.default === true).length !== 1) return 'aiProfileInvalid';
    const claimed = new Set();
    for (const profile of list) {
      for (const feature of profile.features || []) {
        if (claimed.has(feature)) return 'aiProfileInvalid';
        claimed.add(feature);
      }
    }
    return null;
  }

  // 存储里的一项 -> 配置档，或 null：不认识的版本、坏条目都跳过（集合只记数目）。
  // 这里是 normalize 被接住的那一层，错误变成「跳过」，日志由集合打。
  function decode(value) {
    if (!value || typeof value !== 'object' || value.v !== VERSION) return null;
    try {
      return normalize(value);
    } catch (error) {
      return null;
    }
  }

  const collection = SyncCollection.create({
    prefix: KEY_PREFIX,
    decode,
    hosts: () => [],
    limits: { itemBytes: LIMITS.itemBytes, totalBytes: LIMITS.totalBytes, maxItems: LIMITS.maxItems },
    errors: { tooLarge: 'aiProfileTooLarge', budgetFull: 'aiProfilesBudgetFull' },
  });

  // ------------------------------------------------------------ 读

  /**
   * 选档（设计 §0.1-9）：站点规则指定的档 > 挂了这个功能的档 > 默认档。
   * 规则指向的档不在就报错，不回落（§0.1-11）。
   */
  function resolve(profiles, { feature, ruleProfileId } = {}) {
    if (!FEATURES.includes(feature)) throw new TypeError(`AIProfiles.resolve: unknown feature ${feature}`);
    const list = profiles || [];
    if (ruleProfileId) {
      const pinned = list.find((profile) => profile.id === ruleProfileId);
      return pinned ? { profile: pinned } : { error: 'aiProfileMissing', id: ruleProfileId };
    }
    const assigned = list.find((profile) => (profile.features || []).includes(feature));
    if (assigned) return { profile: assigned };
    const fallback = list.find((profile) => profile.default === true);
    return fallback ? { profile: fallback } : { error: 'aiNotConfigured' };
  }

  // resolve 的两种 {error} 对读者各是哪一句。「一档都没有」就是 D1 之前那句「请先配置
  // API Key」：弹出窗口（EngineStatus.aiReady 为假）和页面说同一句，不另起一句。
  const RESOLVE_MESSAGES = Object.freeze({ aiNotConfigured: 'configureApiKeyFirst', aiProfileMissing: 'aiProfileMissing' });

  /** resolve 的错误码 → i18n 键（aiProfileMissing 的 {name} 由调用方填）。 */
  function resolveMessageKey(code) {
    if (!Object.prototype.hasOwnProperty.call(RESOLVE_MESSAGES, code)) {
      throw new TypeError(`AIProfiles.resolveMessageKey: unknown resolve error ${code}`);
    }
    return RESOLVE_MESSAGES[code];
  }

  // 给内容脚本的字段：不含 apiKey，只说缺没缺。
  function publicFields(profile) {
    return {
      name: profile.name,
      provider: profile.provider,
      apiEndpoint: profile.apiEndpoint,
      modelName: profile.modelName,
      features: profile.features.slice(),
      default: profile.default,
      keyMissing: APICompat.isApiKeyMissing(profile),
    };
  }

  /** 给内容脚本的形状：{id, name, provider, apiEndpoint, modelName, features, default, keyMissing}。 */
  function publicView(profile) {
    return Object.assign({ id: profile.id }, publicFields(profile));
  }

  // 内容脚本的镜像：同一前缀，sync 增量经 decode 之后直接是公开形状，Key 不进页面。
  const publicCollection = SyncCollection.create({
    prefix: KEY_PREFIX,
    decode: (value) => {
      const profile = decode(value);
      return profile && publicFields(profile);
    },
    hosts: () => [],
    limits: { itemBytes: LIMITS.itemBytes, totalBytes: LIMITS.totalBytes, maxItems: LIMITS.maxItems },
    errors: { tooLarge: 'aiProfileTooLarge', budgetFull: 'aiProfilesBudgetFull' },
  });

  /**
   * 旧四键 → 一档。四个键一个都没存过时返回 null。没存的键取迁移前的缺省值
   * （DRAFT）—— 这就是旧版本实际在用的配置；不认识的服务商记成 'custom'。
   * 不校验：调用方（迁移、导入）按各自的规矩处理坏的旧值。
   */
  function fromLegacy(settings) {
    const stored = settings || {};
    if (!LEGACY_KEYS.some((key) => stored[key] !== undefined)) return null;
    const pick = (key) => (stored[key] !== undefined ? stored[key] : DRAFT[key]);
    const provider = hasOwn(APICompat.PROVIDERS, pick('provider')) ? pick('provider') : 'custom';
    return {
      v: VERSION,
      name: APICompat.PROVIDERS[provider].name,
      provider,
      apiEndpoint: pick('apiEndpoint'),
      apiKey: pick('apiKey'),
      modelName: pick('modelName'),
      features: [],
      default: true,
      rpm: 0,
      concurrency: 0,
      timeoutSec: DEFAULT_TIMEOUT_SEC,
    };
  }

  /** 集合里的默认档，没有就是 null。 */
  function defaultOf(profiles) {
    return (profiles || []).find((profile) => profile.default === true) || null;
  }

  /**
   * 设置页的卡片和引导页只编辑默认档（设计 §1 表 D1 行）：把 patch 盖到当前默认档
   * 上（没有默认档就盖到 DRAFT 上），返回要交给 put 的整档。纯函数 —— 读存储是
   * 调用方的事。名字没人改过（还是服务商的名字）时跟着服务商走。
   */
  function editDefault(profiles, patch) {
    const current = defaultOf(profiles);
    const base = current || Object.assign({}, DRAFT, { name: APICompat.PROVIDERS[DRAFT.provider].name });
    const next = Object.assign({}, base, patch);
    const renamed = patch.name !== undefined;
    const followsProvider = hasOwn(APICompat.PROVIDERS, base.provider)
      && base.name === APICompat.PROVIDERS[base.provider].name;
    if (!renamed && followsProvider && hasOwn(APICompat.PROVIDERS, next.provider)) {
      next.name = APICompat.PROVIDERS[next.provider].name;
    }
    delete next.updatedAt;
    return next;
  }

  // ------------------------------------------------------------ 写入（SW）

  function checkedId(id) {
    if (!collection.validId(id)) throw invalid();
    return id;
  }

  function assertSet(profiles) {
    const key = validateSet(profiles);
    if (key) throw new Error(key);
  }

  /**
   * 让 incoming 在集合里生效：它们之中有默认档，别的档的默认标记摘掉；它们挂的
   * 功能从别的档上摘掉。返回写后的整个集合和被改动的旧档。
   */
  function adopt(entries, incoming, now) {
    const ids = new Set(incoming.map((profile) => profile.id));
    const claimsDefault = incoming.some((profile) => profile.default);
    const claimed = new Set(incoming.flatMap((profile) => profile.features));
    const touched = [];
    const others = entries.filter((profile) => !ids.has(profile.id)).map((profile) => {
      const dropDefault = claimsDefault && profile.default;
      const features = profile.features.filter((feature) => !claimed.has(feature));
      if (!dropDefault && features.length === profile.features.length) return profile;
      const changed = Object.assign({}, profile, { features, updatedAt: now });
      if (dropDefault) changed.default = false;
      touched.push(changed);
      return changed;
    });
    return { after: others.concat(incoming), touched };
  }

  // 新增或整档替换。别的档一个都没有时，这一档就是默认档。
  function writePut({ profile }) {
    const normalized = normalize(profile);
    const wantedId = profile.id === undefined ? undefined : checkedId(profile.id);
    return collection.write((entries) => {
      const now = Date.now();
      const id = wantedId || collection.newId();
      const next = Object.assign(normalized, { id, updatedAt: now });
      if (!entries.some((other) => other.id !== id)) next.default = true;
      const { after, touched } = adopt(entries, [next], now);
      assertSet(after);
      return { put: [next].concat(touched), result: { id } };
    });
  }

  // 站点规则在调用时才取：custom-rules.js 加载时要先有 AIProfiles（规则 v3 校验
  // 档 id），反过来不行。
  async function rulesUsing(id) {
    const CustomRules = root.CustomRules;
    if (!CustomRules) throw new Error('AIProfiles remove needs shared/custom-rules.js');
    const rules = await CustomRules.cached();
    return rules.filter((rule) => rule.profile === id);
  }

  function writeRemove({ id }) {
    const target = checkedId(id);
    return collection.write(async (entries) => {
      const profile = entries.find((entry) => entry.id === target);
      if (!profile) return { result: { removed: false } };
      const users = await rulesUsing(target);
      if (users.length) {
        const error = new Error('aiProfileInUse');
        error.params = { rules: users.map((rule) => rule.match.join(', ')).join('; ') };
        throw error;
      }
      if (profile.default && entries.length > 1) throw new Error('aiProfileDefaultInUse');
      return { remove: [target], result: { removed: true } };
    });
  }

  /**
   * 整份导入：按 id 合并。keepKeys 为 true 时，没带 apiKey 字段的档沿用本机同 id
   * 那一档的 Key（导出时没勾「包含 API Key」）；为 false 时没带就是空 Key。
   */
  function writeImport({ profiles, keepKeys }) {
    if (!Array.isArray(profiles) || !profiles.length || profiles.length > LIMITS.maxItems) throw invalid();
    if (typeof keepKeys !== 'boolean') throw invalid();
    const incoming = profiles.map((profile) => {
      if (!profile || typeof profile !== 'object') throw invalid();
      return { id: checkedId(profile.id), keyless: profile.apiKey === undefined, profile: normalize(profile) };
    });
    if (new Set(incoming.map((item) => item.id)).size !== incoming.length) throw invalid();
    return collection.write((entries) => {
      const now = Date.now();
      const local = new Map(entries.map((entry) => [entry.id, entry]));
      const items = incoming.map(({ id, keyless, profile }) => {
        const mine = local.get(id);
        const apiKey = keepKeys && keyless && mine ? mine.apiKey : profile.apiKey;
        return Object.assign({}, profile, { id, apiKey, updatedAt: now });
      });
      const { entries: merged, added, replaced } = collection.merge(entries, items, (profile) => profile.id);
      const adopted = merged.filter((profile) => items.some((item) => item.id === profile.id));
      const { after, touched } = adopt(entries, adopted, now);
      // 写后没有默认档（本机原来是空的，文件里又没标）：导进来的第一档当默认。
      if (!after.some((profile) => profile.default)) adopted[0].default = true;
      assertSet(after);
      const put = after.filter((profile) => adopted.includes(profile) || touched.includes(profile));
      return { put, result: { added, replaced } };
    });
  }

  /**
   * 旧四键 → aiProfile:legacy（设计 §2.6）。集合里已有 legacy（另一台设备先迁过
   * 了）就不写；然后删掉四个旧键。旧值本身就是坏的（空模型、空接口地址 —— 旧
   * 版本上也从没用得起来）时不生成配置档，只记一条日志，旧键照删。
   */
  async function writeMigrateLegacy() {
    const sync = root.chrome.storage.sync;
    const stored = await sync.get(Array.from(LEGACY_KEYS));
    const legacy = fromLegacy(stored);
    const result = await collection.write((entries) => {
      if (!legacy || entries.some((entry) => entry.id === LEGACY_ID)) return { result: { migrated: false } };
      let profile;
      try {
        profile = normalize(legacy);
      } catch (error) {
        console.warn('AIProfiles migrateLegacy: legacy settings are not a usable profile, dropping them:', error.message);
        return { result: { migrated: false } };
      }
      const next = Object.assign(profile, { id: LEGACY_ID, updatedAt: Date.now() });
      next.default = !entries.some((entry) => entry.default);
      return { put: [next], result: { migrated: true } };
    });
    await sync.remove(Array.from(LEGACY_KEYS));
    return result;
  }

  // 已知的错误键原样往上走；别的（存储失败、意外）在这里变成 aiProfileSaveFailed
  // —— 原始错误在这一层被接住，所以在这一层记日志（不带配置档内容）。
  function saveError(kind, error) {
    if (error && ERROR_KEYS.has(error.message)) throw error;
    console.error(`AIProfiles ${kind} write failed:`, error);
    throw new Error('aiProfileSaveFailed');
  }

  /** 界面拿到一个错误时能直接查文案的键；别的一律 null。 */
  function userErrorKey(error) {
    const key = error && error.message;
    return ERROR_KEYS.has(key) || key === 'aiProfileSaveFailed' ? key : null;
  }

  function guarded(kind, write) {
    return (message, sender) => Promise.resolve()
      .then(() => write(message || {}, sender))
      .catch((error) => saveError(kind, error));
  }

  const WRITES = {
    put: guarded('put', writePut),
    remove: guarded('remove', writeRemove),
    import: guarded('import', writeImport),
    migrateLegacy: guarded('migrateLegacy', writeMigrateLegacy),
  };

  const { applyWrite, request } = StorageWriter.create({
    type: 'AI_PROFILES_WRITE',
    writes: WRITES,
    errors: 'throw',
  });

  root.AIProfiles = {
    KEY_PREFIX,
    FEATURES,
    DRAFT,
    LEGACY_ID,
    LEGACY_KEYS,
    LIMITS,
    ERROR_KEYS,
    collection,
    publicCollection,
    normalize,
    validate,
    validateSet,
    resolve,
    resolveMessageKey,
    publicView,
    fromLegacy,
    defaultOf,
    editDefault,
    userErrorKey,
    applyWrite,
    request,
  };
})(globalThis);
