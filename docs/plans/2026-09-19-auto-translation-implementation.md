# 叭叭翻译 · 自动翻译 功能设计与实现文档

| 项 | 内容 |
| --- | --- |
| 版本 | v1.0 |
| 日期 | 2026-09-19 |
| 类型 | 工程实现文档（Engineering Design）—— 回答「代码怎么改」，不重复 PRD 的「为什么」 |
| 基线 | 分支 `chore/prompt-audit`，manifest `1.3.1` |
| 目标版本 | 扩展 `1.4.0` |
| 上游文档 | [PRD](./2026-09-19-auto-translation-prd.md)（需求与验收）· [交互设计](./2026-09-19-auto-translation-ux-design.md)（触点）· [现状分析](./2026-09-19-auto-translation-design.md)（差距）· [第三方评审核验](./2026-09-19-parity-review-synthesis.md)（核验结论） |

**阅读顺序**：PRD 说要什么 → 本文说怎么做 → §11 的 PR 切分是执行清单。
PRD 的每条 FR 在本文都能找到落点；反过来本文不新增需求，只做技术决策。

---

## 1. 架构总览

### 1.1 现有加载链（事实）

`manifest.json` 的 `content_scripts` 是一条**扁平有序的脚本列表**，`run_at: document_end`，
全部运行在 ISOLATED world。所有模块通过一个单例互相挂载：

```js
const ctx = window.AI_TRANSLATOR_CONTENT || {};   // content-bootstrap.js:5
window.AI_TRANSLATOR_CONTENT = ctx;
```

- `content-bootstrap.js` 建 `ctx.constants` / `ctx.settings` / `ctx.state`，并定义 `ctx.init`（`:254`）。
- 中间各模块往 `ctx` 上挂函数（`ctx.translatePage`、`ctx.createFloatBall`、`ctx.requestTranslation`…）。
- `content.js` 是最后一个脚本，只做一件事：`window.AI_TRANSLATOR_CONTENT?.init?.()`。

`ctx.init` 里的挂载点全部写成 `if (ctx.setupXxx) ctx.setupXxx()` —— **新模块接入就是加一行同样形状的代码**，
这是既有约定，不要另起炉灶。

另有一个独立的 MAIN world 脚本 `content/youtube-timedtext-interceptor.js`，
`matches` 只有 `*://*.youtube.com/*`。`translator/CLAUDE.md` 约束 C4 明确**不得**把它放宽到 `<all_urls>`。
这条约束直接决定了 §2.5 的 SPA 路由方案。

### 1.2 分层

自动翻译不是一个新功能，是给既有翻译引擎**加一只会自己按快门的手**。因此分五层，
**只有「发现 + 调度」是新的，「执行 + 呈现」一律复用**：

```
决策层  shared/site-rules.js              decide() 纯函数：这页现在该不该自动翻
发现层  content/content-auto-discover.js  MutationObserver + IntersectionObserver -> 候选块
调度层  content/content-auto-translate.js 队列、代次、并发、熔断、静默
执行层  content-page-translation.js（改造） 收集 / 分批 / 请求 / 插入 —— 既有，不重写
呈现层  content-float-ball.js / popup（改造） 状态点、追问条、开关
```

横切三件事：

```
shared/block-identity.js    内容身份（hash + 注册表）—— 幂等与迟到响应的唯一依据
shared/translation-cache.js 两级缓存 —— 决定自动模式的成本可控性
shared/spa-navigation.js    路由信号 —— 正文、字幕、未来的面共用一份
```

### 1.3 新模块在 manifest 中的位置

必须排在**使用它们的模块之前**（无模块系统，靠顺序）：

```jsonc
"js": [
  "i18n/messages.js",
  "shared/account-gate.js",
  "shared/caption-core.js",
  "shared/comic-charge.js",
  "shared/ocr.js",
  "shared/speech-lang.js",
  "shared/default-settings.js",    // 新：默认值单一来源
  "shared/site-rules-builtin.js",  // 新：纯数据，被 site-rules 读
  "shared/site-rules.js",          // 新：纯函数
  "shared/block-identity.js",      // 新：无依赖
  "shared/translation-cache.js",   // 新：依赖 chrome.storage
  "shared/spa-navigation.js",      // 新：无依赖
  "content/content-bootstrap.js",
  "content/content-utils.js",
  // …既有顺序不动…
  "content/page/collect.js",       // 新：由 content-page-translation.js 拆出
  "content/page/batch.js",         // 新：同上
  "content/page/insert.js",        // 新：同上
  "content/page/visibility.js",    // 新：同上
  "content/content-page-translation.js",   // 保留为门面
  "content/content-auto-discover.js",      // 新：依赖 page/collect + block-identity
  "content/content-auto-translate.js",     // 新：依赖 discover + site-rules + page/batch
  "content/content-auto-status.js",        // 新：追问条 + 状态点 UI
  // …
  "content/content-messaging.js",
  "content/content.js"
]
```

---

## 2. 模块设计

每个模块给出：职责、导出、依赖、行数预算（`thermos` 1k 行规则）。

### 2.1 `shared/site-rules.js` — 决策层（约 180 行）

**唯一职责**：回答「这页现在该不该自动翻译」。**纯函数，零 I/O，可直接单测。**

```js
// 全局挂载（与 CaptionCore / AccountGate 同形）
globalThis.SiteRules = {
  decide(input),              // -> Decision
  normalizeHost(hostname),    // 取注册域：mobile.x.com -> x.com
  matchBuiltin(host, path),   // -> Rule | null
};

/**
 * @typedef {Object} DecideInput
 * @property {string}  host         location.hostname
 * @property {string}  path         location.pathname
 * @property {string?} pageLang     页面语言，判不出时为 null
 * @property {string}  targetLang   settings.targetLang
 * @property {Object}  userRules    { 'x.com': 'always' | 'never' }
 * @property {Object}  settings     { autoTranslate, autoTranslateLangs }
 * @property {boolean} explicit     true = 用户在当前页显式点了翻译
 *
 * @typedef {Object} Decision
 * @property {'auto'|'ask'|'off'} verdict
 * @property {string} reason        枚举，见下；用于状态点文案与日志，不得拼字符串
 * @property {Rule?}  rule          命中的内置规则（含 selectors，供适配层用）
 */
```

`reason` 是枚举，**不是人话**（人话在 i18n 里）：

```
GLOBAL_OFF · BLOCKLIST · USER_NEVER · USER_EXPLICIT · USER_ALWAYS · BUILTIN_ALWAYS
SAME_LANGUAGE · LANG_NOT_LISTED · UNKNOWN_LANGUAGE · DEFAULT_ASK
```

**决策顺序**（短路，PRD FR-1.4 + FR-1.6 的四级优先级）：

| # | 条件 | 结果 | 备注 |
| --- | --- | --- | --- |
| 1 | `!explicit && !settings.autoTranslate` | `off` / `GLOBAL_OFF` | 全局闸门 |
| 2 | 内置黑名单命中 | `off` / `BLOCKLIST` | 优先级**高于**用户 `always`（银行、医疗、政务） |
| 3 | 内置规则 `state === 'never'` | `off` / `BLOCKLIST` | 表里的 never 和黑名单对外同一个说法 |
| 4 | `userRules[host] === 'never'` | `off` / `USER_NEVER` | |
| 5 | `explicit` | `auto` / `USER_EXPLICIT` | **第一级：用户显式** |
| 6 | `userRules[host] === 'always'` | `auto` / `USER_ALWAYS` | 同上 |
| 7 | 内置规则 `state === 'always'` | `auto` / `BUILTIN_ALWAYS` | **第二级：站点规则** |
| 8 | `pageLang === targetLang` | `off` / `SAME_LANGUAGE` | **第三级：语言规则** |
| 9 | `autoTranslateLangs` 非空且 `pageLang` 不在其中 | `off` / `LANG_NOT_LISTED` | 同上 |
| 10 | `pageLang == null` | `ask` / `UNKNOWN_LANGUAGE` | 判不出不赌 |
| 11 | 其余 | `ask` / `DEFAULT_ASK` | **第四级：全局默认** |

`explicit === true` 直接给 `auto`（PR-2 实现时对本节的修订，PRD FR-1.6 的落地点）。
初稿写的是「跳过语言规则两条」，但那样一个用户已经点过翻译的页面仍然落在 `ask`——
页面后来长出来的内容该不该跟上，问的还是这个函数，调度层就只能绕过 `decide()` 自己
判一遍，同一个问题两个地方回答。它压得住语言规则和总开关（总开关管的是「我们自己
开始翻」），压不住禁翻的三条：黑名单、内置 `never`、用户 `never`。

总开关排在黑名单之前，是为了理由的可操作性：一个没翻过的页面在总开关关着时，
状态点该说「自动翻译已关闭」，而不是「这个站点被禁了」。两者 verdict 都是 `off`。

### 2.2 `shared/site-rules-builtin.js` — 规则数据（约 220 行，纯数据）

```js
globalThis.SiteRulesBuiltin = {
  schemaVersion: 1,
  rulesVersion: '2026-09-19',
  blocklist: [ /* 见 §7.3 */ ],
  rules: [
    {
      match: 'x.com',                       // 注册域，或 'arxiv.org/abs/*' 路径通配
      state: 'always',
      atomicBlockSelectors: ['[data-testid="tweetText"]'],
      excludeSelectors: ['[data-testid="User-Name"] a', 'time', '[role="group"]'],
      blockIdAttr: null,                    // 见 §7.2
    },
  ],
};
```

**约束**

- 纯数据，**不含任何函数**。加载时用一份内联 schema 校验（字段名、类型、`state` 枚举）；
  校验失败整表回退到内置兜底（空 `rules` + 完整 `blocklist`），**不得崩溃、不得裸奔**。
- 永远不从远端拉规则、更不下发 JS（Chrome remote-hosted-code 政策）。规则更新 = 发版。
- `injectedCss` / 每站引擎 / 每站延迟等字段**不建模** —— 现在不需要，加了就要一直维护。

### 2.3 `shared/block-identity.js` — 内容身份（约 120 行）

自动翻译的**幂等基石**。PRD FR-2.10 的落点。

现状问题：幂等完全靠源元素上的 `.ai-translator-translated`
（打标 `content-page-translation.js:1726`，跳过 `:866-867`）。那是**节点身份**。
X / Reddit 是虚拟列表，回收 DOM 节点时 class 还在、文本已换成另一条推文 → 新内容被静默跳过。

```js
globalThis.BlockIdentity = {
  fingerprint(text),                // NFC + 折叠空白 + trim，再 FNV-1a 32 位；
                                    // 归一化与 hash 不单独导出，见下第 1 条
  register(el, { fingerprint, translationEl, managed }),
  lookup(el),                       // -> Entry | undefined
  isStale(el, currentFingerprint),  // 已登记但指纹变了 = 节点被复用
  forget(el),                       // 只注销，不碰 DOM
};
```

**PR-3 实现时改了四处（已落地，以此处为准）：**

1. **`fingerprint()` 是唯一入口。** 原设计让调用方自己 `hash(normalize(x))`，
   那就有两个地方各归一化一套；一旦登记端和比对端差一步，**每个块都会被判成
   陈旧，翻完立刻重翻** —— 一个会烧钱的死循环。合成一个函数，两头都只能走它。
2. **`release()` 不在这个模块，改名 `ctx.releaseTranslation()` 落在
   `content/page/insert.js`。** 摘译文节点要认识五种插入形态（兄弟、块内、
   slot 内、flex 内联、受管容器的 ::after），还要调 `ctx.releaseManagedTranslation`
   和 `ctx.releaseSourceForTranslation`。让 `shared/` 去摘节点，它就再也不能在
   `node --test` 里跑了。这里只回答「是不是同一段内容」，`forget()` 只注销。
3. **`normalize()` 不转小写，和 `normalizeComparableText` **不**同口径。**
   两者问的不是一个问题：那边问「模型是不是把原文原样还回来了」，宽容才不会把
   大小写差异当成真译文；这边问「这段文字变了没有」，大小写变了就是变了。
4. **`blockId` / `nextBlockId()` 推迟到 PR-6。** 它只给调度器记账（§7.2），
   PR-3 没有任何人读它 —— 本仓不建模现在不需要的字段。

**关键决策：注册表用 `WeakMap<Element, Entry>`，不写 `data-*` 属性。**

第三方评审建议写 `data-bt-hash` 到 DOM 上。不采纳，三个理由：

1. 写 DOM 会**触发我们自己的 MutationObserver**，等于给发现层制造持续噪声，
   还要再写一层过滤去认自己的属性写入 —— 引入问题再解决它。
2. 污染宿主页面。站点自己的 selector、快照测试、CSP 报告都可能撞上。
3. WeakMap 随节点被 GC 自动清理，无泄漏；`data-*` 需要手工清。

代价：跨 document 的节点克隆会丢失身份 —— 正是我们想要的行为（克隆体应当重新翻译）。

`.ai-translator-translated` **保留**，但降级为纯样式钩子，不再承担幂等职责。
`collectTranslatableBlocks` 里 `:866-867` 的跳过条件改为查注册表（见 §4.1）。

### 2.4 `shared/translation-cache.js` — 两级缓存（实际 298 行，已实现 / PR-4）

PRD FR-7 落点。信息流重复率极高（转推引用、重复回帖、回访），没有缓存，
AI 引擎下的自动模式成本不可控。

```js
globalThis.TranslationCache = {
  TTL_MS,
  buildKey({ text, targetLang, endpoint, model, prompt, version }),
  async serve(texts, factors, fetchMissing),  // 一批进、等长一批出
  async flush(),
  async sweep(),        // 由 background 的 chrome.alarms 每天驱动
};
```

- **键**：`hash([text, targetLang, endpoint, model, prompt, version].join(SEP))`，
  `SEP` 取 `U+0000`，`hash` 是两条起点不同的 FNV-1a 32 位 lane 拼成的 16 位十六进制。
- **L1**：进程内 `Map` + 插入序 LRU，上限 2000 条。
- **L2**：`chrome.storage.local`，**一条目一个 `tc:<hash>` 键**。
  写入批量攒 500ms 再落盘。
- **过期**：30 天，清理挂在 background 的 `chrome.alarms` 上（`PDF_POLL_ALARM` 先例），每天一次。
- **in-flight 合并**：`Map<key, Promise>`，同一批里重复文本、以及并发批次之间的
  重复文本，都只发一次请求。

**PR-4 实现时改了六处，每一处都是设计稿的缺陷而不是妥协：**

1. **只缓存 AI 引擎，只缓存 `TRANSLATE_BATCH_FAST`。** 内置引擎（Chrome 端上的
   Translator）零网络零费用，缓存它省下几十毫秒、花掉用户 10 MB storage 配额里的
   一大块（本扩展没申请 `unlimitedStorage`，PDF 任务和漫画令牌住在同一块地方）；
   顺带消掉了设计稿没看见的一个洞 —— 内置引擎按**页面语言**推断源语言，同一段英文
   在法语页面和英语页面上译出来可以不一样，跨页复用会串味，而 AI 那条路压根不声明
   源语言。**因此 `sourceLang` 和 `engine` 都不在键里**，不是省略，是不存在。
   划词/悬停/输入框（`TRANSLATE`）也不缓存：它们是用户一次一次点出来的，量小且几乎
   不重复，而且返回是 `{translation, phonetic, isWord}` 另一种形状。
2. **`glossaryVersion` 删除。** 全仓库没有术语库这个功能（grep 零命中）。
   为不存在的功能留字段，违反本目录 `CLAUDE.md` 的无历史包袱铁律。
3. **`promptVersion` 手工常量 → `version`（扩展版本号）+ `prompt`（用户自定义提示词原文）。**
   设计稿那条「改提示词时同步 +1，写进 `translator/CLAUDE.md` 否则一定会忘」是在给
   自己布置一个必然被忘掉的作业。提示词只有两个来源：我们的 `DEFAULT_BATCH_PROMPT`
   （改它必然伴随一次发版，而发版必然改 manifest 版本号，忘不掉）和用户的
   `settings.customPrompt` —— **后者设计稿整个漏掉了**，那是真正的正确性缺口：
   用户改完自定义提示词，旧译文会继续按旧口径供货。代价是每次更新扩展作废一次缓存，
   条目本来也只活 30 天。
4. **`endpoint` 进键。** 同名模型挂在不同网关（OpenAI / OpenRouter / 本地 Ollama）
   后面是两个东西。`apiKey` 不进键，也永远不该进：它不改变译文，而键会以明文落进 storage。
5. **`get`/`set`/`stats` → 一个 `serve()`。** 逐条 `get`/`set` 的形状会让每个调用方
   自己实现「哪些命中、哪些要发、回来怎么按位置塞回去」——而**顺序和长度是这里唯一
   不能出错的地方**（上游按位置回填，多一条少一条就是 A 块挂上 B 块的译文）。
   一个入口意味着只有一份对齐代码，并且同批去重、跨批 in-flight 合并、回写都在它里面。
   `stats()` 没有调用方，按铁律删掉，PR-10 要统计时连同消费方一起加。
6. **条目数上限 → 字节预算（4 MB，`getBytesInUse()`）。** 段落长度能差一个数量级，
   条数是很差的代理；而真正的约束是 `chrome.storage.local` 那 10 MB。超预算时一次
   扔掉四分之一最旧的，而不是刚好扔到预算线上——踩着线清理，下一次翻译立刻又超。

**接线**：`content/content-translation-cache.js`（101 行）是桥，
`content/page/batch.js` 的三个 `TRANSLATE_BATCH_FAST` 出口统一走
`ctx.requestTranslationCached`（与 `ctx.requestTranslation` 同形）。
单开一个桥文件是因为 `content/content-translation-engine.js` 已经 902 行，
而且设置页也加载它（那里没有 `ctx`，也没有页面翻译）。

**已知留白**：`shared/caption-core.js` 的字幕翻译也走 `TRANSLATE_BATCH_FAST`，
重看同一个视频是重复率很高的场景，但它不在本 PR 的范围里（字幕是用户开着字幕时
一次性的、有界的量）。要接的话接在同一个 `serve()` 上，不需要新代码。

### 2.5 `shared/spa-navigation.js` — 路由信号（159 行，已实现）

PRD FR-2.8 落点。**这里有一个必须纠正的技术前提。**

> **不能 monkeypatch `history.pushState`。**
> content script 跑在 ISOLATED world，与页面共享 DOM 但**不共享 JS 全局与原型**。
> 在隔离世界里改 `History.prototype.pushState` 对页面自己的调用**完全无效**。
> PRD FR-2.8 原文写的「订阅 `pushState` / `replaceState` / `popstate`」在这个前提下不成立，
> 已据此修订 PRD。

唯一能绕开的办法是注入 MAIN world 脚本，但 `translator/CLAUDE.md` C4 禁止把现有 YouTube 拦截器放宽到
`<all_urls>`，而为路由感知单开一个全站 MAIN world 脚本代价过大（每页多一次注入）。因此三路并用：

| 路径 | 覆盖 | 可靠性 |
| --- | --- | --- |
| `window.addEventListener('popstate' / 'hashchange')` | 后退/前进、锚点跳转 | 浏览器派发，隔离世界收得到，可靠 |
| `window.navigation`（Navigation API）的 `navigatesuccess` 事件 | 同文档导航，含 `pushState` | Chrome 102+；存在即用，不存在就跳过 |
| URL 轮询 | 兜底，覆盖前两者漏掉的一切 | 字符串比较，`document.visibilityState === 'visible'` 时每 800ms 一次；页面隐藏时停 |

```js
globalThis.SpaNavigation = {
  POLL_INTERVAL_MS,    // 800
  currentUrl(),
  onRouteChange(cb),   // cb({ from, to, via: 'popstate'|'hashchange'|'navigation'|'poll' })，返回 unsubscribe
};
```

**字幕、漫画、未来的面共用这一份**，不得各写一套（`CLAUDE.md` Coherence 条款）。

实现时相对上面这份设计有三处偏离，都是刻意的：

1. **去重按「上一次播报出去的 URL」，不是 250ms 时间窗。** 时间窗在两头都不对：
   一次 `popstate` 之后 800ms 才轮到的那一次轮询远在窗外，照样会为同一次导航再播一声 ——
   实际上按时间窗写出来的版本会对**同一个 URL** 每 800ms 重播一次，永不停止；
   而窗内它又会吃掉真导航 —— 在锚点密集的文档页上，250ms 内 A→B→A 是一次普通操作，
   用户确实回到了 A，下游确实需要知道。按 URL 去重两头都对：同一次导航三路各喊一声只播一次，
   哪怕相隔几秒；A→B→A 播两次，因为那本来就是两次。单元测试两条都钉着
   （「哪怕相隔远超 250ms」「250ms 内 A→B→A 是两次」），把实现换回时间窗版本会红。
2. **订 `navigatesuccess` 而不是 `navigate`。** `navigate` 在导航**提交前**触发，
   那一刻 `location.href` 还是旧值，于是这一路要么得从 event 上另取 URL（三路各有一套取法），
   要么会为一次被取消的导航白播一声。改订 `navigatesuccess` 之后三路都是「事件只管触发，
   URL 一律现读 `location.href`」——一个事实来源，三个触发器。
3. **`via` 报事件自己的名字**，所以联合类型里多一个 `'hashchange'`。
   把 hashchange 混报成 `'popstate'` 会让下游的日志和将来的按路径调优失去分辨力，
   而这两件事对使用者本来就不同：锚点跳转通常不换内容，`popstate` 通常换。

另有一处留给 PR-6 验证而不是在本 PR 里断言：隔离世界的 `window.navigation` 是否真的
会为页面自己的 `pushState` 触发。轮询是兜底，这一路成不成立都不影响正确性，只影响
「多快发现」；而要确认它需要一个真实 SPA 的 e2e，那正是 PR-6 的路由重译旅程。

### 2.6 `content/content-auto-discover.js` — 发现层（约 260 行）

```js
ctx.setupAutoDiscovery = function ({ onCandidates }) {
  // -> { stop, rescan, suspend, resume }
};
```

四级管线，每级都在往下游**减量**：

```
1) MutationObserver(document.body, { childList: true, subtree: true, characterData: true })
   -> 过滤自身产物（见下）-> 收集「变化子树根」集合 -> 400ms 防抖
2) 对每个变化子树根跑 collectTranslatableBlocks(root)
   （既有函数已接受 root 参数，见 content-page-translation.js:637 —— 不需要新写收集逻辑）
3) 每个候选块交给 IntersectionObserver.observe，rootMargin: '100% 0px'
   -> 这一步同时实现了 PRD FR-9 的「仅翻译视口 ±1 屏」：进入带内才算候选
4) 进入带内 -> 查身份注册表 -> 未登记 或 hash 变了 -> 交给 onCandidates
```

**自译回环防护**（PRD FR-2.5，R1 风险）。两道，缺一不可：

1. **挂起计数器**：插入译文前后 `suspend()` / `resume()`，计数器 > 0 时丢弃全部 records。
   单靠它不够 —— 插入是异步分批的，挂起窗口内页面自己的变更也会被吞掉。
2. **产物过滤**：`records` 逐条判断，满足任一即丢弃：
   - `record.target` 在 `.ai-translator-inline-block` / `.ai-translator-popup` 内部；
   - `addedNodes` 全部带 `ai-translator-` 前缀的 class；
   - `characterData` 的目标解析到最近的已登记块后 hash 未变。

第 2 道是常态防线，第 1 道只用来压掉插入期的洪峰。

**characterData 的成本**：页面上的计数器、时钟会持续触发。缓解就在第 4 步的 hash 比较：
文本没变就地丢弃，不进队列。这一步是 O(文本长度) 的 FNV，可接受。

### 2.7 `content/content-auto-translate.js` — 调度层（约 320 行）

```js
ctx.setupAutoTranslate = function () {};   // 由 ctx.init 调用
ctx.autoTranslate = {
  state(),                     // 'off' | 'idle' | 'running' | 'paused' | 'error'
  pauseCurrentPage(),
  resumeCurrentPage(),
  bumpSession(reason),         // 代次自增
  sessionVersion(),
};
```

职责：

1. **启动判定**：`document_end` 后 → `requestAnimationFrame` → 250ms 防抖 → 判页面语言 → `decide()`。
   250ms 不是拍脑袋：X / Reddit 的 SSR→hydration 会整片重建首屏，过早收集到的块在下一帧就全被替换掉。
2. **页面语言判定**：取首屏最靠前的 5–8 个候选块正文拼接（上限 2000 字符）→
   `chrome.i18n.detectLanguage` → 置信度 ≥ 85% 才采信。
   阈值复用 `isTargetLanguageText()` 的那一处（`content-page-translation.js:1381`），
   **不得新增第二套阈值**（PRD C6）。
3. **队列**：`Map<Element, { hash, blockId, enqueuedAt }>`，插入序即优先级
   （IntersectionObserver 的回调顺序天然近似阅读顺序）。
4. **代次**：`sessionVersion` 在五种事件自增 —— 路由变化、目标语言变化、引擎变化、
   用户恢复原文、用户暂停。自增时清空队列并放弃在途结果。
5. **驱动**：队列非空且未在跑 → 取出一批 → `ctx.runTranslationPass(blocks, { quiet: true, sessionVersion })`。
   本轮结束后立刻检查队列 —— **这是 `state.isTranslatingPage` 必须从「拒绝」改成「排队」的原因**（§5.1）。
6. **熔断**：复用既有 `MAX_BATCH_FAILURES = 3`。自动模式下熔断**不弹错误**，
   只把状态点置 `error`，并停止本页调度直到用户手动重试。

### 2.8 `content/content-auto-status.js` — 状态呈现（约 200 行）

PRD FR-3 的触点二（追问条）与触点三（状态点）。

- **追问条**：`decide()` 返回 `ask` 时，页面右下角一条极窄的条（不是弹窗、不遮挡内容），
  两个按钮「翻译」「不用」，外加一个「总是翻译 x.com」勾选。
  同一域名追问 3 次未选择后**永久静默**（`siteAskCount`，PRD 数据模型已有）。
- **状态点**：悬浮球上的一个 6px 圆点，五态对应
  `idle`（无点）/ `running`（呼吸）/ `partial`（黄）/ `error`（红）/ `paused`（灰）。
  点状态点 → 展开一行说明（含 `decide()` 的 `reason` 与失败计数），不做浮层。

---

## 3. 数据结构与契约

### 3.1 存储 schema

```jsonc
// chrome.storage.sync —— 跨设备，体积敏感（单项 8KB）
{
  "autoTranslate": true,                 // 全局闸门
  "siteRules": { "x.com": "always" },    // 只存用户显式设过的域名，内置规则不落盘
  "autoTranslateEngine": "builtin",      // builtin | ai
  "autoTranslateLangs": [],              // 空 = 除目标语言外全部
  "autoEnableCaptions": false,           // 副作用开关，与正文自动翻译独立
  "aiAutoDailyBudget": 200000,           // 字符/天，仅 AI 引擎生效
  "engineFallback": "local-only",        // local-only | allow-ai   <- FR-9.1
  "skipTargetLanguageText": true,        // 原 autoDetect 改名（M0-e）
  "uiLanguage": "",                      // 空 = 跟随浏览器；不再由 targetLang 推导（M0-b）
  "writingTargetLanguage": ""            // 空 = 回落 targetLang；输入框方向与阅读方向分开
}

// chrome.storage.local —— 本机，可增长
{
  "siteAskCount":     { "example.com": 2 },
  "translationCache": { "<key>": { "t": "译文", "ts": 1758240000000 } },
  "autoStats":        { "month": "2026-09", "pages": 312, "cacheHit": 0.61, "aiChars": 18420 }
}
```

**默认值单一来源**。当前默认值在 `content/content-bootstrap.js` 里**重复了三处**
（`:41` 初始化、`:121` `storage.sync.get` 的默认对象、`:153` 失败回落），
`background/background.js` 里还有一份 `defaultSettings`。新键**不得**沿袭这个模式：
本轮把它收敛成 `shared/default-settings.js` 一处导出、四处引用（PR-0b 顺手做掉）。

### 3.2 翻译请求契约扩展

既有 `TRANSLATE_BATCH_FAST`（`background/background.js:556`）保持不变，
在 content 侧的请求对象上**追加三个字段**，由调度层填、由插入前的校验读，
**不发给 background**（它们是页面内的事，没必要过 IPC）：

```js
{ sessionVersion, blockId, textHash }
```

**插入前三重校验**（PRD FR-2.11）：

```js
function acceptResult(el, req) {
  if (!el.isConnected) return false;                                    // 节点已被移除
  if (BlockIdentity.hash(getText(el)) !== req.textHash) return false;   // 内容已变（节点被复用）
  if (req.sessionVersion !== ctx.autoTranslate.sessionVersion()) return false;  // 会话已过期
  return true;
}
```

三条全过才插入。**字幕面复用同一个函数**（§8），不得另写一套。

### 3.3 ctx 上新增的挂载点

```js
ctx.runTranslationPass(blocks, opts)  // 执行层，由 content-page-translation 拆出（§5.1）
ctx.setupAutoDiscovery(cfg)           // 发现层
ctx.setupAutoTranslate()              // 调度层，进 ctx.init
ctx.autoTranslate                     // 调度层对外状态
ctx.autoStatus                        // 状态点 / 追问条控制
```

---

## 4. 核心算法

### 4.1 幂等判定（替换 class 检查）

```js
// content/page/collect.js，processElement 内，**排在 closest() 跳过链之前**
const identity = globalThis.BlockIdentity;
if (identity.lookup(element)) {
  if (!identity.isStale(element, identity.fingerprint(readSourceText(element)))) return;
  ctx.releaseTranslation(element);   // 节点被复用：摘掉旧译文，当作新块重来
}
```

三个实现要点，都是照原样写会出错的地方：

- **必须排在 `element.closest('.ai-translator-popup, .ai-translator-translated, …')`
  之前。** 那条选择器串里就有 `.ai-translator-translated`，而 `closest()` 从元素
  自己开始找 —— 排在它后面，回收的块会先被当成「已翻译」挡掉，陈旧判定再也没有
  机会发生。
- **文本不能用 `getDirectText()`。** 它只读直接子文本节点，而 X 的
  `[data-testid="tweetText"]` 把正文分装在一串 `<span>` 里，读出来是空字符串：
  整列推文指纹相同，回收一次也认不出来。PR-3 为此在 `collect.js` 里加了
  `readSourceText(element)` —— 整棵子树读一遍，**只**跳过我们自己插进去的
  `.ai-translator-inline-block`。`.ai-translator-inline-source` 看着像我们的类名，
  其实打在**页面自己的块**上（悬停译过的那一块），跳掉就是把真正的正文从指纹里
  抹去。**登记端和比对端必须是同一个读法**，否则同上：每块都陈旧，翻完立刻重翻。
- **只对已登记的元素读子树。** 这一步不便宜，所以代价跟着已翻块数走，不跟着
  页面 DOM 大小走。

`ctx.releaseTranslation()`（在 `insert.js`）摘的东西比一个 `remove()` 多：
为译文让出位置而藏起来的原文要放回去（`ctx.releaseSourceForTranslation`，
和 fit guard 撤译文那条路成对），受管 `::after` 要走
`ctx.releaseManagedTranslation`，最后 `.ai-translator-translated` 必须摘掉 ——
它是上面那条 `closest()` 串里的一员，留着的话放开的块下一轮照样被跳过。

### 4.2 代次与迟到响应（PR-6）

代次要作废的是**队列和在途请求**，两样都是调度器的东西，PR-3 没有它们可作废，
所以这一节整体跟着调度层走。


`sessionVersion` 是一个模块级整数，自增时做三件事：清队列、标记在途请求作废、
把 `BlockIdentity` 里属于旧路由的条目在**下次扫描时**惰性清理（不主动遍历，代价太大）。

迟到响应**不做「取消请求」** —— `chrome.runtime.sendMessage` 没有可靠的取消，
而且请求已经发出去了、钱也已经花了。只在**写回前丢弃**。这是唯一正确的层次。

### 4.3 并发按引擎（PRD FR-2.12）

现状 `CONCURRENCY = 12`（`content-page-translation.js:24`）对两条路径用同一个数。
内置引擎在**批内是串行的** —— `content-translation-engine.js:641-661` 是一个
`for (const text of texts) { await translateWithBuiltin(...) }`，
12 路并发只是让 12 个批同时去抢同一份本地模型资源，多出来的是排队与内存占用，
不是吞吐；云端引擎是**网络并发**，12 才有意义。具体数值在 PR-4 后用真实页面实测校准，
`builtin: 4` 是起点不是结论。

```js
const CONCURRENCY = { builtin: 4, ai: 12 };   // 单点常量，按 usingBuiltinEngine() 取
```

`usingBuiltinEngine()` 已存在（`content-page-translation.js:552`），直接用。

### 4.4 批次构造

**不动**。`createSmartBatches()`（`:557`）与三个上限
（`MAX_BATCH_CHARS 9000` `:20`、`MAX_BATCH_ITEMS 40` `:21`、`MAX_BATCH_TOKENS 3200` `:22`）
在自动模式下同样适用。自动模式唯一的差别是**入口块集合更小、来得更频繁**。

### 4.5 缓存查表的位置

在 `createSmartBatches` **之前**：先用缓存把命中的块直接插入，剩下的才进批次。
放在之后会白白构造批次再拆开。

---

## 5. 对既有代码的改造

### 5.1 `content/content-page-translation.js`（2282 行 → 拆分）

**这是本轮最大的一处结构改动，且必须先于功能开发完成**（PRD C1，`thermos` 1k 行规则）。
拆法按既有函数的天然边界，**纯搬运，零行为变化**：

| 新文件 | 搬入内容 | 约行数 |
| --- | --- | --- |
| `content/page/collect.js` | `collectTranslatableBlocks`(:637) 及其内部全部启发式（`holdsCode`、`looksLikeCode`、`isMainlyUrl`、`isNumericOrSymbolOnly`、`wrapDirectTextRuns`、`processElement`…），`isMathElement`、`isMarkupElement`、`getTextWithMathPlaceholders` | 620 |
| `content/page/batch.js` | `estimateTokens`、`splitBlocksByViewport`(:465)、`splitTextIntoChunks`、`createSmartBatches`(:557)、`runWithConcurrency`(:611)、**新增 `runTranslationPass`** | 400 |
| `content/page/insert.js` | `insertTranslationBlock`(:1717)、`buildTranslationContent*`、`appendTextWithMath`、`finishTranslationInsert`、`getTranslationPlacement` | 560 |
| `content/page/visibility.js` | `revealHiddenTranslations`(:305)、`hideSourceForTranslation`、`applyTranslationOnlyMode`(:418)、`releaseSourceForTranslation` | 260 |
| `content-page-translation.js`（保留） | `translatePage()` 门面、`filterBlocksByLanguage`(:1477)、`shouldSkipTranslation` | 280 |

**新增 `runTranslationPass(blocks, options)`**：把 `translatePage()` 里
「收集 → 过滤 → 视口切分 → 分批 → 并发 → 插入」的**后四段**原样抽出。

```js
async function runTranslationPass(blocks, { quiet = false, sessionVersion = 0 } = {}) { /* … */ }

// translatePage 变成
async function translatePage(options = {}) {
  // …
  let blocks = collectTranslatableBlocks(document.body);
  blocks = await filterBlocksByLanguage(blocks);
  // …
  return runTranslationPass(blocks, options);
}
```

自动调度层喂自己的块集合进 `runTranslationPass`，**不重新扫全页**。
两条路走同一段执行代码 —— 这是「不写第二份翻译实现」的技术保证。

**`quiet` 模式**：影响三处，全部是 UI 调用，逻辑不变：
`showPageTranslationProgress()` / `updatePageTranslationProgress()` / `showPageNotice()`
在 `quiet` 时改为 no-op，状态改由 `ctx.autoStatus` 承接。

**`state.isTranslatingPage` 从「拒绝」改成「排队」**：
现在并发调用会走到 `:84` 的分支，只「闪烁提示正在翻译中」（`showTranslatingHint`）。
自动模式下滚动会持续产生新块，这个分支等于把它们全丢了。改为：
`quiet` 模式下不提示、不返回，把块并入当前队列；本轮 `runTranslationPass` 结束后再取。
**手动模式的行为保持原样**（用户连点两次仍然是闪烁提示）。

### 5.2 `content/content-bootstrap.js`

- 默认值三处合一（§3.1）。
- `ctx.t` 的 `getUILanguage(ctx.settings.targetLang)`（`:95`）改为读 `settings.uiLanguage`（M0-b）。
- `ctx.init`（`:254`）末尾加两行：

```js
if (ctx.setupAutoTranslate) ctx.setupAutoTranslate();
if (ctx.setupAutoStatus) ctx.setupAutoStatus();
```

放在 `setupVideoCaptionTranslation` 之后、`resumeComicJobs` 之前 —— 要在悬浮球建好之后
（状态点挂在悬浮球上），且不能 await（判语言要跑 IPC）。

### 5.3 `content/content-float-ball.js`

- **单击语义改为「翻译 / 还原」**（D1 已定案）。`:324` 的 `else { toggleFloatMenu(); }` 改为
  `else { togglePageTranslation(); }`；菜单入口改为悬浮球 hover 时出现的 `···`（触屏长按）。
- `handleMenuAction` 的 `translate-page`（`:509`）与 `toggle-translations`（`:517`）两个 case 保留
  —— 菜单仍然可以走，只是不再是**唯一**路径。
- 状态点：在 `#ai-translator-float-ball` 内加一个 `<span class="ai-translator-status-dot">`，
  由 `ctx.autoStatus` 驱动。CSS 进 `content/content.css`，**必须落在宿主页 CSS 隔离带的
  `:is()` 列表里**（`translator/CLAUDE.md` C5），且不得用 `!important`。

### 5.4 `popup/`

**修 `checkStatus()`**（M0-a，`popup/popup.js:485`）。正确写法就在同一文件 `:504`：

```js
// 现在（错）：默认引擎本就免 Key，却无条件按 apiKey 报错
if (!settings.apiKey) { elements.statusText.textContent = t('apiNotConfigured'); /* … */ }

// 改为：按当前引擎的真实可用性算
const engine = settings.translationEngine || 'builtin';
const ready = engine === 'ai'
  ? !!settings.apiKey            // 只有 BYOK 才需要 Key
  : await probeBuiltin();
```

`probeBuiltin()` 不能在 popup 里直接探 —— popup 自己的 `self.Translator` 与内容页不是一回事
（`isSecureContext` 对 popup 恒为 true，而目标页可能是 `http://`）。
改为向**当前标签页**发一条 `PROBE_ENGINE` 消息，由已注入的 content script 调用既有的
`isBuiltinSupported()`（`content-translation-engine.js:64`）回答，超时 300ms 回落为「未知」。
四态文案：`本地翻译已就绪` / `正在准备语言包` / `此页面用不了本地翻译（原因）` / `请先配置接口`。

**信息架构收敛到四行**（D5）：①当前站点 + 引擎真实状态 ②翻译 / 恢复 ③本站自动翻译 ④暂停本页。
第③行复用既有 `<kbd>` 芯片形态（`popup.html:34`、`:43` 已有两个先例），不引入新控件。
双语 / 仅译文、目标语言、更多入口留在设置页与悬浮球菜单。

### 5.5 `i18n/messages.js` + `_locales/`（10 语）

- **`getUILanguage(targetLang)` 解耦**（M0-b，`:2873`）。改签名为 `getUILanguage(explicitUiLang)`，
  空值时回落 `chrome.i18n.getUILanguage()`（浏览器语言），**不再看 `targetLang`**。
  五处调用同步改：`background/background.js:226`、`popup/popup.js:42`、`options/options.js:44`、
  `pdf/upload.js:54`、`content/content-bootstrap.js:95`。
- 新增文案键约 28 个（状态四态、追问条、状态点五态、设置项标签与说明、回退提示）。
  `_locales/` 十个语言目录（de / en / es / fr / ja / ko / pt_BR / ru / zh_CN / zh_TW）全部补齐 ——
  这是既有硬性约定。

### 5.6 `manifest.json`

```jsonc
"minimum_chrome_version": "116",   // D4 倾向保留，但必须配合 M0-a 的如实降级说明
"commands": {                       // 新增，PRD FR-12
  "toggle-translate-page": {
    "suggested_key": { "default": "Alt+A" },
    "description": "__MSG_cmdTogglePage__"
  }
}
```

`Alt+A` 与悬浮球单击**完全同义**（翻译 / 还原），不是第三种语义。
`chrome.commands` 的处理落在 `background/background.js`，向活动标签页转发一条消息，
content 侧走与悬浮球单击**同一个函数**。

### 5.7 `background/background.js`

- `chrome.commands.onCommand` 监听（上条）。
- 缓存清理挂到既有 `chrome.alarms`（`TranslationCache.sweep()`）。
- `handleBatchTranslateFast` **不动**。它的分隔符对齐保护（`:1887` 段数不等即整批回退编号法）
  是自动模式的前提条件，动它风险远大于收益。

---

## 6. M0：先修的既有缺陷

M0 全是现存缺陷，**先于任何新功能**。理由很简单：自动翻译默认开的前提是「默认就能翻出来」。

| # | 缺陷 | 位置 | 改法 |
| --- | --- | --- | --- |
| M0-a | 免 Key 默认用户被报「未配置 API」 | `popup/popup.js:485` | §5.4 |
| M0-b | UI 语言跟着翻译目标语言走 | `i18n/messages.js:2873` + 5 处调用 | §5.5 |
| M0-c | `minimum_chrome_version: 116` vs 内置引擎需 138 | `manifest.json:7` | D4：保留 116，但 M0-a 的状态必须如实说「这个浏览器用不了本地翻译」 |
| M0-d | 引擎回退静默花钱 | `content-translation-engine.js:684-709` | 加 `engineFallback` 设置；`local-only` 时 `canFallBackToAI()` 恒假；回退发生时置状态点并记一条可见说明 |
| M0-e | `autoDetect` 名实不符 | `options/` + bootstrap 三处默认值 | 改名 `skipTargetLanguageText`；**无历史包袱铁律**：不留旧键兼容读取，发版即换 |

**M0 出口**：Chrome 138 全新安装、不登录、不填 Key，打开一个英文页面能出译文，popup 不报错。

---

## 7. 站点适配层

### 7.1 适配的边界

站点规则只回答两件事：**哪些节点是正文**、**哪些不是**。
它**不**改翻译流程、**不**改插入方式、**不**带每站特例代码。做不到这一点的站点就先不支持。

### 7.2 `blockId` 的来源

调度层需要一个块标识用于队列记账与日志。三级回落：

1. 站点规则声明的属性（如推文卡片祖先上的某个 id）—— 目前**全为 null**，
   因为真实 DOM 未实测（PRD §13.2 待办）；
2. `WeakMap` 分配的会话内自增整数 —— **默认路径**，够用；
3. **不用 DOM path** —— 虚拟列表下 DOM path 恰恰是稳定的，反而会掩盖节点复用。

**载荷全在 `textHash` 上，`blockId` 只做记账。** 这点必须写清楚，
否则后来者会误以为 `blockId` 是幂等依据。

正因为它只做记账，PR-3 的 `BlockIdentity` **没有**这个字段：那一层没有人读它。
它和 `nextBlockId()` 一起落在 PR-6 —— 调度器到场的同一个 PR。

### 7.3 首批规则

| 站点 | state | 要点 |
| --- | --- | --- |
| `arxiv.org`（`/abs/*`） | `always` | 摘要页结构稳定，风险最低，作为首个内置 `always` |
| `x.com` | `always` | 原子块 `[data-testid="tweetText"]`；排除用户名、时间、`[role="group"]`（互动条） |
| `reddit.com` / `old.reddit.com` | `always` | 标题、正文、评论各为独立块；折叠分支不预译 |
| `news.ycombinator.com` | `always` | 结构极简，作为回归基线 |
| **黑名单**（优先级最高） | `never` | 银行 / 支付域、`*.gov`、医疗门户、邮箱与在线文档编辑器（Gmail / Outlook / Docs / Notion）—— 在别人的编辑器里插节点是灾难 |

规则表是数据，失效时的退化路径是「翻得碎」而非「翻不了」（通用启发式兜底）。

---

## 8. 字幕面的复用

PRD FR-5。字幕**已经**有完整实现（provider 分层、timedtext 拦截、分句、批次、播放位置优先），
本轮只做三件事，全部是**接上自动化，不是重写**：

1. **自动开启**：`decide()` 对当前站点返回 `auto` 且 `autoEnableCaptions` 为真时，
   由 `ctx.setupVideoCaptionTranslation` 已有的入口自动启动。
   注意评审指出的「双开关困惑」：`content-caption-providers.js:100` 靠
   `.ytp-subtitles-button[aria-pressed]` 判断原字幕是否已开，
   `shared/caption-core.js:309 pickSubtitleTrack()` 从不激活 `disabled` 轨 ——
   自动开启必须先把原字幕点开；点不开时在播放器菜单里直说「请先开启原字幕」并给动作，
   **不能静默什么都不做**。
2. **代次复用**：切视频 / 切语言 / 切模型时调 `ctx.autoTranslate.bumpSession()`，
   `translateCues` 的写回前加 §3.2 的校验。**不另写一套字幕代次**。
3. **滑动窗口预译**：现在 `ensureTrackTranslated()`（`content-video-captions.js:465`）
   会把整条轨道译完。本地引擎无所谓，云端引擎是实打实的浪费。
   改为播放点前后各 N 分钟的窗口，拖动进度后重排；`showYoutubeOriginalCaption` 为真时
   暂停新的云端预取。

**顺带加固**（PRD §13.3，P2）：`translateCues()`（`:386`）按下标回写，
当前上游两条路径都保证条数相等（AI 路径 `background.js:1887` 段数不等即回退编号法，
内置路径逐条 push），所以**不是线上 bug**；但万一出现短数组，尾部 cue 会永久留在
`state.pendingKeys` 里，既不重试也不显示。在函数开头加一行：

```js
if (response.translations.length !== cues.length) { markBatchFailed(cues); return false; }
```

让它走既有的冷却重试路径。

---

## 9. 测试计划

两层，与仓库既有结构一致：`node --test 'test/unit/**/*.test.mjs'` 与 `npx playwright test`。

### 9.1 单测（`test/unit/`）

| 文件 | 覆盖 | 对应验收 |
| --- | --- | --- |
| `site-rules.test.mjs` | `decide()` 全部短路分支（每条 reason 都要被覆盖到）；黑名单优先于用户 `always`；`explicit` 压得住总开关、压不住禁翻三条；注册域归一（`mobile.x.com` → `x.com`）；语言口径与 `CaptionCore.getLangBase` 一致 | FR-1 |
| `site-rules-schema.test.mjs` | 规则表 schema 校验；坏字段整表回退到兜底且不抛 | FR-1.7 |
| `block-identity.test.mjs` | hash 稳定性与归一化；`isStale` 在文本变化时为真；`readSourceText` 不把译文算进原文；`ctx.releaseTranslation` 摘译文节点、放回原文、清标记；判定排在 `closest()` 之前 | FR-2.10 |
| `translation-cache.test.mjs` | **已落地（PR-4，20 条）**：6 个因子每一个都改变键；因子边界不滑动；L1 命中零请求；**换一份新模块实例（空 L1）后 L2 仍命中**；换模型后不命中；同批去重；并发 in-flight 合并；失败不记账且等待方自己重发；条数对不上整批作废；空译文传回但不缓存；30 天过期；sweep 的过期/畸形/字节预算三条；超 L1 容量的调用不出空洞；三份装载清单 | FR-7 |
| `spa-navigation.test.mjs` | 三路信号按「上次播报的 URL」去重（同一次导航只发一次，A→B→A 发两次）；`navigation` 缺失时降级到轮询；页面隐藏停心跳 | FR-2.8 |
| `session-guard.test.mjs` | `acceptResult` 三条校验各自独立生效 | FR-2.11 |

单测跑在 Node 里，所以这六个模块**必须零 DOM 依赖或可注入 DOM** ——
这也是把它们放进 `shared/` 而非 `content/` 的原因之一。

### 9.2 e2e（`test/e2e/`）

既有模式：`fixtures.js` 提供带扩展的 context，`helpers.js` 的
`setExtensionSettings` / `triggerPageTranslation` / `waitForTranslationComplete`，
`mock-openai-server.js` 的 `startMockOpenAIServer()` 提供可断言的假接口
（返回的 `fastBatchRequests` 能直接数请求次数）。
「本地 fixture」的既有做法是 `page.goto('https://example.com')` 之后用 `page.evaluate` 注入 DOM
（见 `page-translation-highlight-class.spec.js`）—— **不依赖真实站点**（PRD C8，X 有登录墙）。

| 文件 | 场景 | 对应验收 |
| --- | --- | --- |
| `auto-translate-basic.spec.js` | 规则为 `always` 的域打开即译；`never` 不译；`ask` 出追问条且不自动译 | FR-1 / FR-3 |
| `auto-translate-incremental.spec.js` | 注入无限滚动 fixture，滚 10 屏，新块全部被译、无块被译两次 | FR-2 |
| `page-translation-recycled-block.spec.js` | **已落地（PR-3）**：改块内文字后再点一次整页翻译，断言新内容被译、旧译文节点被摘掉，且没变的块这一轮**根本没发出去**（断 `sentTexts` 而不是只看 DOM） | FR-2.10 |
| `page-translation-cache.spec.js` | **已落地（PR-4）**：整页翻译一次 → 等落盘 → **reload**（L1 随页面消失）→ 同样的文字再译一次，断言 `sentTexts` 一条都没增加、且页面上确有译文。用 reload 而不是原地再点一次，是因为同页第二次命中 L1 证明不了译文走完了 `chrome.storage.local` 那一圈 | FR-7 |
| `auto-translate-virtualized.spec.js` | 上一条的滚动版：真虚拟列表回收，反复 100 次无错配。发现层要在才写得出来，随 PR-6 | FR-2.10（评审补入） |
| `auto-translate-spa.spec.js` | `history.pushState` 切 3 次路由，每次重新判定并翻译；旧路由在途结果不写回 | FR-2.8 / FR-2.11 |
| `auto-translate-loop-guard.spec.js` | 插入译文不触发新一轮翻译；注入 10k 节点爆发后 CPU 回落 | FR-2.5 / R1 |
| `auto-translate-quiet.spec.js` | 自动模式全程无进度条、无 toast | FR-2.7 |
| `auto-translate-budget.spec.js` | AI 引擎达每日预算后停止并提示（缓存那半已由 `page-translation-cache.spec.js` 覆盖） | FR-9 |
| `engine-fallback.spec.js` | `local-only` 下 `http://` 页面**零网络请求**；`allow-ai` 下回退有可见痕迹 | FR-9.1 |
| `popup-status.spec.js` | 无 Key + builtin → 不报错；`ai` + 无 Key → 报错 | M0-a |
| `ui-language-decoupling.spec.js` | 改 `targetLang` 不改界面语言 | M0-b |

`mock-openai-server.js` 的 `fastBatchRequests` 让「第二次翻译请求数为 0」和「预算耗尽后停止」
成为可断言的硬指标，而不是靠看截图。

### 9.3 真机实测（PRD §13.2，M3 前必须做）

单测和 e2e 都跑在构造的 DOM 上，证明不了真站。三项：
① X 推文正文实际被切成几块 ② Reddit 正文在 light DOM 还是 shadow root
③ 点开 YouTube CC 后 timedtext 拦截器能否稳定拿到 ASR 轨。

---

## 10. 非功能

| 项 | 要求 | 落点 |
| --- | --- | --- |
| 首屏 | 自动翻译不得阻塞首屏渲染 | `document_end` + rAF + 250ms 防抖；判语言限 2000 字符 |
| CPU | 空闲时回落基线 | 观察器 400ms 防抖；characterData 经 hash 早退；IntersectionObserver 代替 scroll 监听 |
| 内存 | 无无界增长 | `WeakMap` 注册表随节点 GC；L1 缓存上限 2000；`pagehide` 时断开全部观察器 |
| 存储 | 有上限 | L2 缓存 20000 条软上限 + 30 天过期；`siteRules` 超 200 条提示清理 |
| 隐私 | 不采集 | 全仓现无任何遥测（已 grep 确认 `analytics|telemetry|gtag|measurement_id` 零命中），本轮**不新增**。统计只落本机 `autoStats` 给用户自己看 |
| 无障碍 | 键盘可达 | 追问条、状态点、popup 四行均可 Tab / Enter 操作；`Alt+A` 提供无鼠标路径 |

---

## 11. 实施计划（PR 切分）

每个 PR 一次 `python3 /Users/dylanwang/github-workflow/scripts/github_pr_workflow.py .`，
本地三门（`npm run test:unit`、`npx playwright test`、手工装载冒烟）全过才推。

| PR | 内容 | 关键文件 | 出口 |
| --- | --- | --- | --- |
| **PR-0a** | M0-a/c/d：引擎状态、回退设置、manifest 口径 | `popup/popup.js`、`content-translation-engine.js`、`options/`、`manifest.json` | 免 Key 默认不报错；`local-only` 下零计费请求 |
| **PR-0b** | M0-b/e：语言解耦、`autoDetect` 改名、默认值单一来源 | `i18n/messages.js` + 5 处调用、`shared/default-settings.js`、`content-bootstrap.js` | 改翻译语言不改界面语言；默认值只有一处 |
| **PR-1** | `content-page-translation.js` 拆四个文件 + 抽 `runTranslationPass` | `content/page/*.js`、`manifest.json` | **纯搬运**，既有全部 e2e 原样通过 |
| **PR-2** | 决策层 | `shared/site-rules.js`、`shared/site-rules-builtin.js` | `site-rules.test.mjs` 全绿；无 UI 变化 |
| **PR-3** | 内容身份（幂等基石） | `shared/block-identity.js`、`content/page/collect.js`、`insert.js` | `block-identity.test.mjs` 全绿；`page-translation-recycled-block.spec.js` 在真浏览器里走通「改文字→重译、没改→不重发」；手动翻译行为不变 |
| **PR-4** | 两级缓存 | `shared/translation-cache.js`、`background/background.js`（alarm） | 第二次翻译请求数为 0 |
| **PR-5** | 路由信号 | `shared/spa-navigation.js` | 三路去重单测绿 |
| **PR-6** | 发现层 + 调度层 + 代次/迟到校验（**自动翻译在此可用**） | `content-auto-discover.js`、`content-auto-translate.js` | 打开即译 / 滚动续译 / 路由重译 三条 e2e 绿 |
| **PR-7** | 交互四触点 | `content-auto-status.js`、`content-float-ball.js`、`popup/`、`manifest.json`(commands) | 启用 ≤3 次点击；关闭不离开页面；`Alt+A` 可用 |
| **PR-8** | 站点适配首批规则 | `shared/site-rules-builtin.js`、`content/page/collect.js`（原子块） | X / Reddit / arXiv / HN fixture 回归 |
| **PR-9** | 字幕面接入 | `content-video-captions.js`、`content-caption-providers.js` | 自动开启；滑动窗口；切视频无残留 |
| **PR-10** | 设置页审计表、本机统计、10 语文案、商店材料 | `options/`、`_locales/*` | 全量回归 + 商店描述与隐私政策同步 |

**里程碑映射**：PR-0a/0b = M0；PR-1…PR-6 = M1；PR-7 = M2；PR-8/9 = M3；PR-10 = M4。

**顺序的硬依赖**：PR-1 必须在 PR-3 / PR-6 之前（否则新逻辑往 2282 行的文件里塞，质量复审必挂）；
PR-2 / 3 / 4 / 5 相互独立，可并行；PR-6 依赖 2、3、5；PR-7 依赖 6。

---

## 12. 风险与回滚

| # | 风险 | 缓解 | 回滚粒度 |
| --- | --- | --- | --- |
| R1 | 观察器与自插译文死循环 | 双重防护（挂起计数 + 产物过滤），专门 e2e | 关 `autoTranslate` 全局闸门即退回现状 |
| R2 | 重型站点卡顿 | 防抖 + 视口带过滤 + 熔断沿用 | 同上 |
| R3 | AI 引擎意外费用 | `engineFallback` 默认 `local-only` + 每日预算 + 缓存 | 同上 |
| R4 | PR-1 拆分引入回归 | 纯搬运、不改逻辑；既有 e2e 全绿才合 | 单独 revert PR-1 |
| R5 | X / Reddit DOM 变更 | 规则是数据，小版本可单独更新；失效退化为「翻得碎」不是「翻不了」 | 改数据发版 |
| R6 | 隐私争议 / 商店审核 | 黑名单 + 本地引擎默认 + 不采集 + 商店材料同步 | PR-10 前不上架 |
| R7 | 内置引擎在部分环境不可用 | 能力探测已有（`content-translation-engine.js:64-69`），M0-a 让它如实说话 | — |

**全局回滚开关**：`autoTranslate: false` 一个键关掉整条新链路，
所有既有手动路径不受影响 —— 这是把闸门做成独立 setting 而不是「有无规则」的原因。

---

## 13. 待裁决项（不阻塞实现，PR 前必须有答案）

| # | 问题 | 倾向 | 最迟需要 |
| --- | --- | --- | --- |
| D2 | 全局 `autoTranslate` 默认开还是默认关 | 默认开（配合 `ask` 追问条，不会突然翻） | PR-6 |
| D3 | 首批内置 `always` 站点范围 | §7.3 四站 | PR-8 |
| D4 | `minimum_chrome_version` 保留 116 还是提到 138 | 保留 116 + 如实降级说明 | PR-0a |
| D5 | popup 收敛到几行 | 4 行（§5.4） | PR-7 |

D1（悬浮球单击语义）**已定案**为「改成翻译 / 还原切换」，第三方评审独立收敛到同一结论。

---

## 14. 附录：文件总表

**新增（14）**

估算值；已落地的模块在括号里标出**实际**行数（PR-4 时点）。

```
shared/default-settings.js         80  (94)   默认值单一来源
shared/site-rules.js              180  (305)  决策纯函数
shared/site-rules-builtin.js      220  (88)   规则数据（首批规则在 PR-8 才填）
shared/block-identity.js          120  (114)  内容身份
shared/translation-cache.js       200  (298)  两级缓存
shared/spa-navigation.js          159         路由信号
content/page/collect.js           620  (852)  由 content-page-translation 拆出
content/page/batch.js             400  (511)  同上（含新增 runTranslationPass）
content/page/insert.js            560  (499)  同上
content/page/visibility.js        260  (172)  同上
content/page/progress.js               (363)  同上（原表漏列）
content/content-translation-cache.js    (101)  缓存桥接（PR-4 新增，原表未列：
                                               引擎 902 行放不下，且设置页也加载引擎）
content/content-auto-discover.js  260         发现层
content/content-auto-translate.js 320         调度层
content/content-auto-status.js    200         状态呈现
```

全部在 1k 行以内。拆分后 `content-page-translation.js` 从 2282 行降到 109 行。

**`content/page/collect.js` 是唯一需要盯的：852 行，而 PR-8 还要往里加原子块选择器。**
真到了顶就再拆一次（文本提取 / 跳过判据 / 块构造是三件事），但那是一次纯搬运，
要单独一个 PR，不能混在加功能的 PR 里 —— PR-1 就是这么做的。

**改动（11）**

```
manifest.json                          脚本顺序、commands、（D4）版本口径
content/content-bootstrap.js           默认值收敛、uiLanguage、init 挂载
content/content-page-translation.js    拆分 + 门面 + quiet + 排队
content/content-float-ball.js          单击语义、状态点
content/content-translation-engine.js  engineFallback
content/content-video-captions.js      代次、滑动窗口、条数校验
content/content-caption-providers.js   自动开启原字幕
popup/popup.js + popup.html            状态修复 + 四行 IA
options/options.js + options.html      新设置项 + 审计表
background/background.js               commands、cache alarm
i18n/messages.js + _locales/*(10)      解耦 + 新文案约 28 键
```

**关键代码位置索引**（本文引用过的，供实现时直接跳转）

```
content-page-translation.js:24    CONCURRENCY = 12（改为按引擎）
content-page-translation.js:74    translatePage()（加 options）
content-page-translation.js:84    isTranslatingPage 拒绝分支（改排队）
content-page-translation.js:465   splitBlocksByViewport
content-page-translation.js:552   usingBuiltinEngine
content-page-translation.js:557   createSmartBatches
content-page-translation.js:611   runWithConcurrency
content-page-translation.js:637   collectTranslatableBlocks(root)（已接受 root）
content-page-translation.js:866   幂等跳过（改查注册表）
content-page-translation.js:1381  isTargetLanguageText（85% 阈值唯一来源）
content-page-translation.js:1477  filterBlocksByLanguage
content-page-translation.js:1717  insertTranslationBlock
content-page-translation.js:1726  .ai-translator-translated 打标（降级为样式钩子）
content-translation-engine.js:64  isBuiltinSupported（能力探测，已有）
content-translation-engine.js:684 requestTranslation 的静默回退（加 engineFallback）
content-video-captions.js:386     translateCues（加条数校验 + 代次）
content-video-captions.js:465     ensureTrackTranslated（改滑动窗口）
content-caption-providers.js:100  isCaptionsEnabled（自动开启原字幕）
shared/caption-core.js:309        pickSubtitleTrack（不激活 disabled 轨）
background/background.js:556      TRANSLATE_BATCH_FAST 入口
background/background.js:1887     分隔符段数保护（不动）
popup/popup.js:485                checkStatus 的错误判断（修）
popup/popup.js:504                正确写法的参照
i18n/messages.js:2873             getUILanguage（解耦）
manifest.json:7                   minimum_chrome_version
content-bootstrap.js:41/121/153   默认值三处重复（收敛）
content-bootstrap.js:254          ctx.init（挂载点）
content-float-ball.js:324         单击 -> toggleFloatMenu（改）
```
