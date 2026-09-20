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
  normalizeHost(hostname),    // 规则的键：这台主机本身，只脱 www.
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
      match: 'x.com',                       // 主机名（含子域），或 'arxiv.org/abs/*' 路径通配
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

### 2.6 `content/content-auto-discover.js` — 发现层（落地 374 行，注释占一半）

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

### 2.7 `content/content-auto-translate.js` — 调度层（落地 430 行，注释占一半）

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

划词和悬停的快捷键是「单独一个修饰键」（默认 Control / Shift，可配成 Alt），
和 `Alt+A` 的第一下 keydown 长得一模一样：不管的话，用户按一次 `Alt+A` 会既译一句
又译一页，两次请求。所以这类单修饰键触发统一过 `content-utils.js` 的
`armModifierTap()`——松开才算数，中间来了别的键就作废。悬停另外开 `hold: true`：
它的手势本来就是「按住，划过哪段译哪段」，所以按住超过一瞬也算数；划词是「点一下」，
不开这一档——按着 Ctrl 伸手去够 C 的那半秒不该变成一次翻译。

和弦还可以来得更晚：按住 Alt 超过一瞬（按住档自己动了手）、或者按着 Alt 先划了一段
（悬停当场就译了），这才去够 A。那时候已经译出来的一段留着——请求已经付过了，当场
撤掉只会更怪——但这一按要接着盯到松手为止（`spentTap`），后面来的那个键把 `onChord`
补跑一次。少了这道补刀，`hotkeyDown` 一直是真，松手之前划过多少段就是多少次请求。

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
| `site-rules.test.mjs` | `decide()` 全部短路分支（每条 reason 都要被覆盖到）；黑名单优先于用户 `always`；`explicit` 压得住总开关、压不住禁翻三条；规则按精确主机名存（`alice.github.io` 不圈进 `bob.github.io`），放大靠查找时的父域链；语言口径与 `CaptionCore.getLangBase` 一致 | FR-1 |
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
| **PR-10** | 设置页审计表（**每条可删**）、本机统计、10 语文案、商店材料 | `options/`、`_locales/*` | 全量回归 + 商店描述与隐私政策同步 |

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
content/content-language-pack.js        (151)  语言包的预取与「装好了」通知
                                               （PR-6 第八轮由引擎拆出，见第 26 条）
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

---

## 15. 实现与本文的偏离（PR-6 落地时记录）

本文是落地前写的。真写出来时有二十八处和上文不同 —— 这里逐条记下**为什么**，
免得后来的人照着上文去"修正"代码，把当时刻意绕开的坑重新踩一遍。

| # | 本文原说 | 实际实现 | 为什么 |
| --- | --- | --- | --- |
| 1 | §2.6 `suspend()` 期间发现到的候选**丢弃** | **攒着**，`resume()` 时补送 | 丢弃会漏内容：插译文那几百毫秒里懒加载长出来的段落，是页面自己的变动，不是我们的产物。丢了它就再也没有第二次机会 —— MutationObserver 不会重播。攒着最坏是多一轮空跑，台账会拦住重复。 |
| 2 | §5.1 `runTranslationPass` 加 `quiet` 参数抑制 UI | **没有这个参数** | PR-1 拆分时进度条和悬浮球状态已经留在 `content-page-translation.js` 那一层，`page/batch.js` 里本来就没有 UI 调用。再加个开关是给不存在的问题上锁。 |
| 3 | §5.1 自动轮撞上 `state.isTranslatingPage` 时"排队" | 调度层自己的 `running` 闸 + 500ms 重试 | 队列要处理的是"用户手动翻译正在跑"这一种情况，而那一轮跑完会把整页都翻掉 —— 排在后面的自动轮醒来时无事可做。一个重试计时器就够，且不用跨模块共享队列状态。 |
| 4 | §2.7 `markPageExplicit()` 无条件记录 | 记录前先看 `settings.autoTranslate` | 总开关是关的时候，用户手动翻一次不该让这一页从此"自动"起来 —— 那是把一次动作读成了长期授权。 |
| 5 | §2.7 `pagehide` 时拆掉观察器 | **不拆** | bfcache：`pagehide` 之后页面可能原样回来，观察器拆了就不会再装。而页面真的走了的时候，整个 JS 环境跟着没了，本来也不用谁来拆。 |
| 6 | §2.7 状态机 off/pending/idle/running/paused/error | 多一个 **`ask`** | "该问用户"和"还没判完"（`pending`）不是一回事，PR-7 的追问条要认的正是前者。少这一态，状态呈现层只能去猜。 |
| 7 | — | 自动轮也过 `ctx.filterBlocksByLanguage` | 本文没提，写 e2e 时才发现：`skipTargetLanguageText` 只有手动那条路认。自动这一轮绕过去，就是把用户明确说过不必发的文字一屏一屏替他发出去，而页面上看不出任何异样。由 `auto-translate-wiring.test.mjs` 钉住。 |
| 8 | — | 自动轮传 `allowDownload: false` |  语言包是几十 MB 的下载，`create()` 触发它要求 user activation。自动这一轮没有手势，硬触发只换回一个 `NotAllowedError`，白等一次创建超时再回落。和悬停、字幕这两条同样无手势的路取齐。 |
| 9 | §2.6 超过观察上限就**摘掉**多余的块 | 摘下来的进 `deferred`，位置让出来时按远近换人 | 摘掉＝永久丢失：静态长文里读者滚过去既不产生 DOM 变动、也不触发重扫，被摘掉的那一段永远是原文。观察的那 2000 个始终是**离视口最近的**，所以读者必然先经过它们（进带即摘腾出位置）才会走到 `deferred` 那一段；锚点一跃跳过中间全部的情形由一个滚动监听兜底。 |
| 10 | §2.7 各个重启点自己 `bumpSession()` | `bumpSession()` 收进 `start()` 里 | 漏一个调用点就是一次「旧结果覆盖新判定」，而那条路上没有任何报错 —— 只有页面一直空着或者语言再也探不出来。收进去之后「重判一次」和「翻篇一次」在代码里是同一个动作，漏不掉。 |
| 11 | — | 探语言的 `await` 前后也要对代次 | 只看 `status === PENDING` 拦不住换路由：`start()` 把新的一页也放回 `PENDING`，于是上一页的语言被拿来判这一页。 |
| 12 | — | 排队时就把**原样文字**的指纹记下来，开跑前拿它比 | 原本比的是 `BlockIdentity.fingerprint(block.text)`。但 `block.text` 是「送去翻译的文本」—— 带公式占位符 `{{n}}`、带内联标记、而且 trim 过；`ticket.textFingerprint` 读的是 `readSourceText()` 的素文字。两个表示法永远对不上，于是**凡是带链接、带强调、带公式的段落一律被丢掉**，而发现层已经把它们摘下观察了，再没有东西把它们送回来。改成排队那一刻也走 `guard.stamp()`，两边同一个入口。 |
| 13 | §2.7 「隐藏译文」只在切换时暂停 | 闩收进 `start()`，且「翻译整页」也要把它放回来 | 换路由会无条件 `start()`，于是用户藏起译文、翻到下一页，译文自己又冒出来 —— 而菜单上仍写着「已隐藏」，新插进去的译文也不带 `ai-translator-hidden`，那个开关就此成了摆设。同一类的第二个洞顺手补掉：`revealHiddenTranslations()` 原本只在「确实藏着东西」时才置位 `translationsVisible`，于是在一个还没有译文的页面上藏一次、再点「翻译整页」，自动翻译从此不再醒。 |
| 14 | §5.1 迟到的结果靠 `accept` 拒掉就够了 | `runTranslationPass` 再收一个 `isAborted`，跑到一半也能停 | `accept` 拦的是**回填**：翻都翻完了才拒，钱已经花掉。一轮自动翻译可能横跨一次路由切换或一次改设置 —— 并发 12、几百块的队列，用户关掉自动翻译或换掉付费引擎之后账单还在涨，而页面上一个字都不会变。`batch.js` 里原本有三处各问各的「要不要停」，合成一个 `aborted()`，否则逐块回退那条路只认内部的 `batchError`，外面喊停喊不动它。 |
| 15 | — | 换路由要让 `pageSourceLangPromise` 过期，**由引擎自己订路由** | 单页应用换页时 document 没换，这个模块级缓存就一直是上一篇的语言。中文页跳到英文页之后，短于 40 字的块不自己探语言、直接用缓存里的 `zh`，而目标也是 `zh` —— 判成「已经是目标语言」原样退回，短句永远不译。清缓存不放在调度层换页那一处：划词、悬停、字幕走的是同一个 `resolveSourceLang`，自动翻译关着的时候它们照样在这条路上。谁拥有缓存谁负责让它过期。 |
| 16 | §4.3 | 「一跃跳走」那道门量的是**真正在滚的那个容器**，不是 `window` | 候选常常长在一个内部滚动容器里（侧栏、面板、自己滚的信息流）。滚它一样会派发到那个捕获监听上，但 `window.scrollY` 一动不动 —— 门永远关着。那种页面上超出观察上限的那一截就此卡在 `deferred` 里：留下的块没有一个会进带，也就没有别的路会排重排，信息流的尾巴永远是原文。改成按事件的 `target` 记位置（`WeakMap`，容器是页面自己的节点）、门槛取这个容器自己的一屏高。 |
| 17 | §2.7 换目标语言＝调度层重启一轮 | 目标语言进**译文的身份登记**，`isStale()` 多问一维 | 只重启不够：页面上每一块的登记还在，原文一个字没变，指纹自然一致 —— 收集那一层一看「登记过、不陈旧」就跳过。用户把目标语言从中文改成日文之后，已经翻出来的那一片永远停在中文，只有之后新滚出来的才是日文，而页面上看不出异样（两种都是「译文」）。修在身份这一层，手动整页翻译一并修好。两头都能退回从前：登记时没说语言、或者问的人没带目标语言，一律不问这一问 —— 把「没说」当成某个具体值会让每一块都判成陈旧，放开、重翻、再登记、再判陈旧，是个烧钱的死循环。 |
| 18 | §2.7 台账在**发出去那一刻**记 | 记账**等结果**，而结果由翻译层报上来（`onSettled`） | 一轮里失败不到三次不算整体故障（`MAX_BATCH_FAILURES`），这一轮照样「成功」结束，只是那几块一个字都没翻。先记账它们就此被当成翻过了：发现层下一轮送回来，调度层一看台账，跳过 —— 页面上那一片永远是原文，没有报错、没有重试。报点放在 `batch.js` 唯一的写回口，因为「模型把原文原样还回来了（不用翻）」和「译文写回去了」同样是终局，漏报哪一种都要再花一次同样的钱；调度层猜不出这两者。 |
| 19 | §2.7 `RESTART_KEYS` 五个键 | 再加 `apiKey` / `apiEndpoint` / `modelName` / `engineFallback` | 这四个是**用来救场的**：一页因为密钥没填、填错、地址或模型写错停在 `ERROR` 之后，用户去设置页改对了却不重来，这一页就一直停在那儿，直到他自己想起来刷新。`engineFallback` 同理 —— 内置引擎在这台机器上用不了时，把它从 `local-only` 改成 `allow-ai` 正是那一页唯一的活路。顺手把 `content-bootstrap.js` 里那句「自动翻译要看五个键」的注释改掉：名单归调度层所有，转发那一层不该复述它（那句注释过期，正是因为它在复述）。 |
| 20 | §2.7 `RESTART_KEYS` 五个键 | 再加 `skipTargetLanguageText`，并写下这份名单的**来源规则** | 第 19 条补了四个救场用的键，仍然是「想起一个补一个」。这一条把规则写出来：**凡是喂进「这一页翻不翻」或者「这一块翻不翻」的设置键，都得在名单里**。照这条去对，`shared/site-rules.js` 的 `decide` 读的、`content/page/batch.js` 读的一个都不能漏 —— 漏掉的后果和前四个一样，不报错：把「跳过已是目标语言的文字」从开改成关之后，那些被误判跳过的块，key 还在台账里、元素早被发现层摘了，新设置永远轮不到它们。钉子不再是列字符串，而是去那两个文件里把实际读到的键扫出来对账，将来任何一边新加一个键都会红。 |
| 21 | — | 语言包装好之后，停在 `ERROR` 上的那一页要自己活过来 | 默认设置是内置引擎，而一台没装过语言包的机器上，自动这一轮（无手势、`allowDownload: false`）必然拿回 `builtinNeedsDownload` —— 整页停在 `ERROR`，且调度层不会自己再试。用户随后的第一次点击触发了 `setupLanguagePackPrefetch` 的下载，包落地了，可这一页仍然空着，除非他想起来刷新。引擎装完包时喊一嗓子（`ctx.onLanguagePackReady`），调度层接住就 `start()` —— 这是这一页唯一不用刷新就能变好的时刻。喊的人放在引擎里，因为「包能用了」这件事只有它知道；订的人照 `SpaNavigation.onRouteChange` 那个样子写。设置页 `ensureDownloaded` 装包的那条路跨上下文，喊不到已经打开的标签页，留给 PR-10。 |
| 22 | §2.7 一轮跑完就把 `inflight` 清掉 | 这一轮**没走到结果**的块放回队列，但每个 key 只放一次 | 第 18 条把记账改成等结果之后留下的缺口：批次失败一两次够不上 `MAX_BATCH_FAILURES`，这一轮照样「成功」结束，那几块既不在台账里、也不在队列里 —— 发现层进带时就把它们摘了，一张静止的页面不会再有任何变动把它们送回来。所以由调度层亲自放回。但不能无限放：一个在某几块上稳定失败的接口会让它们每 250ms 重来一次，成了一个花钱的死循环。每个 key 给一次重来，再失败就记进台账（走 `commit()`，所以 `ledger.add(` 全文仍只有一处）。代次一翻篇 `retried` 跟着清空。 |
| 23 | §2.6 观察名额按离视口的远近排 | 没有布局盒子的候选排到**最后**，且比较函数要防 `NaN` | `getBoundingClientRect()` 在 `display:none` 的折叠面板上全是 0，照「离视口多远」那几条算出来是 `-0` —— 和一块**正在视口里**的内容同一档。排序是稳定的，于是文档里靠前的两千个隐藏块会把名额占满不放，真正在看的正文一直待在 `deferred` 里。排到最后（`Infinity`）而不是直接剔除：它们迟早会被展开，而 MutationObserver 只看 `childList`/`characterData`，展开是一次属性变动它看不见 —— 那时候唯一能把这一块捞回来的，就是还挂在它身上的 IntersectionObserver。顺带：两个 `Infinity` 相减是 `NaN`，而返回 `NaN` 的比较函数排出来的顺序没有定义，所以相等要先短路掉。 |
| 24 | §2.7 换目标语言＝调度层重启一轮（第 17 条：语言进身份登记） | 一轮翻译**开跑那一刻**把目标语言定死，一路带到落笔；落笔处不再问设置 | 第 17 条把目标语言写进了译文的身份，但戳是在**插入的那一刻**现问设置拿到的。一轮翻译要跑几十秒：用户在中途把目标语言从中文改成日文，早几批发出去的请求拿回来的仍然是**中文**译文，插进去却被盖上「日文」的戳。下一轮收集端一看「登记过、语言也对」——跳过。那一片中文译文就此永远留在一个日文页面上，没有报错、页面上也看不出异样（两种都是「译文」）。反过来（请求用新的、戳按旧的）只是白翻一轮，不留错的东西 —— 但两个读数取自同一个 `passTarget()`，两种都不会发生：这一轮整个是旧语言的，改设置由 `RESTART_KEYS` 另起一轮来接。`passTarget()` 一次读出两门：`request` 是发给引擎的（「跟随浏览器」要补成具体语言，请求里非填不可），`stamp` 是记进身份的（`currentTargetLang()` 的空串**就是**「跟随浏览器」这个哨兵，登记端和比对端同读同写，补了反而对不上）。 |
| 25 | — | 语言包预取**记着自己是为哪个语言对挂的**，且在两个「缺包」抛出点就地重挂 | 预取只在初始化时挂一次（`content-bootstrap.js`）。用户随后换了目标语言、换了引擎、或者单页应用翻到另一篇别的语言的文章之后，挂着的那一对就过期了 —— 而一个带着过期语言对的监听**比没有更糟**：用户的下一次点击会把**别的**包下下来，真正缺的那个永远没人下，页面上看不出任何异样。修法比「换设置时重探一次」便宜，覆盖也更宽：一次真实翻译因缺包失败的那两处，`src`/`tgt` 现成，就地挂上即可 —— 换语言、换引擎、换路由这三种过期情形都会让下一轮翻译重新发起，而那一轮一样会撞上缺包，一次多余的 `availability` 往返都不花。同一时刻只挂一对（同一对重复挂是空操作，换一对先拆旧的）。两道门同问同答，都是 `downloadTargetLang()`：**挂的时候**挡掉不是这一页目标语言的那一对（划词、输入框弹窗上各有一个一次性的语言下拉，用它译一句日文不代表这一页要译成日文；挡在拆旧的之前，所以被拒的这一次不动已经挂好的那一对），**触发的时候**再确认一次没过期（挂上之后、点下去之前用户仍可能改设置）。顺带修掉一个同源的哑巴缺陷：加载时那次探测原本读的是 `toApiLang(settings.targetLang)`，于是**目标语言设成「跟随浏览器」的用户从来没有过预取** —— 空串归一化之后是假值，函数在第一行就返回了，没有任何报错。 |
| 26 | — | 语言包那一层从引擎里拆出来，成了 `content/content-language-pack.js` | 第 25 条把预取写厚之后，`content-translation-engine.js` 到了 **1024 行**，越过仓库的 1k 行线。拆哪一块不是按行数挑的：预取回答的是「**要不要提前花用户的带宽**」，通知回答的是「**谁在等这个包**」—— 两件都不是「怎么翻」，放在引擎里是层次放错了（表里 `content-translation-cache.js` 当初也是这么出来的）。拆完引擎 902 行。接缝几乎是现成的：新模块只用 `ctx.builtinTranslator` 的公开面，引擎为此只多露两个它自己才知道答案的谓词（`supportsLang` / `pageSourceLang`），而两处缺包时的挂载改成 `ctx.armLanguagePackPrefetch(src, tgt)` —— 都是运行时调用，所以 manifest 里谁先谁后都不影响。钉子两条：新模块里不许出现 `SUPPORTED_LANGS` / `getTranslator(` / `probeAvailability(`（伸手进内部，这次拆分就白做了），以及这个文件必须在 manifest 的名单里（漏了的话调度层那句订阅会当场 TypeError，响是响，但整个初始化断在那儿）。 |
| 27 | §5.1 `.ai-translator-translated` 降级为样式钩子、幂等改查注册表 | **落笔端**的那道重复门也改问注册表，而且陈旧的那一条是**换掉**不是拒收 | 收集端（`page/collect.js`）早就改问 `BlockIdentity.isStale()` 了，落笔端（`insertTranslationBlock`）却还只看 class —— 两端问的不是同一个问题，而它们中间隔着一次网络往返。用户在一轮手动整页翻译跑着的时候改目标语言，调度层按 `RESTART_KEYS` 另起一轮，两轮同时在飞：某一块被新一轮收走之后、它的译文回来之前，旧那一轮的中文译文抢先落了地。新一轮的译文回来时落笔端只看 class，一律拒收 —— **静默地什么都没写**，而调用方照样把这一块记进台账（`onSettled` 是无条件报的）。页面上那条旧语言的译文从此没有任何东西会再动它：收集端下一轮同样先看 class，连指纹都懒得算。整页看起来就是「改了语言但有几块没跟上」，刷新之前永远如此。改法是把收集端那三行原样搬到落笔端：问同一个 `isStale()`，陈旧就先 `releaseTranslation()` 再插。`onSettled` 保持无条件 —— 「换了语言所以拒收」这种情形已经不存在，剩下的两种拒收（同内容同语言、划词原文壳子）都是终局，改成「插成功才记账」反而会让后者每一轮重新花同一笔钱。（这一条只修对了半个方向，反方向的窟窿见第 28 条。） |

| 28 | 同上 | 落笔端换不换，裁决者是**此刻该译成的那门语言**，不是先来后到 | 第 27 条把「语言不一样就换掉」写成了无条件，于是同一场竞速的另一半翻了车：新那一轮的日文先落地，手动那一轮的中文随后才回来，一样「语言不一样」，于是把已经正确的日文又换回了中文 —— 而新那一轮的台账早把这一块记成有结果了，从此同样没人再动它。页面停在旧语言，和第 27 条要修的那个局面一模一样，只是走了另一条路进去。根因是那道门只比了两方（页面上那条的语言、我们这条的语言），两方比出来的只能是先后顺序，而先后顺序是网络说了算的。补上第三方：`ctx.currentTargetLang()` —— 我们这条正是它才有资格换掉页面上那条，不是它就按「晚到的旧货」处理，不动页面。这一处现问设置和第 24 条不矛盾，两条管的是两件事：第 24 条管**记什么戳**（必须是发请求时那一门，否则戳和译文对不上），这一条管**谁说了算**（只能是用户此刻要的那一门）；钉子因此从「`insert.js` 里不许出现 `currentTargetLang`」改成「只许出现在裁决者里」。拒收晚到的旧货不会漏译：改语言必然伴随一次重开，调度层 `bumpSession()` 清空台账、收集端把旧语言的块放开，真正该译的那一轮自己会把它收走。 |

评审（Codex）在 PR #89 上跑了十轮，共 24 条，全部属实、全部已修。

第一轮 5 条：语言包下载手势、虚拟列表回收导致的「旧文字配新指纹」、跨代次的状态
覆盖、观察器淘汰把首屏摘掉、换引擎不重扫。前四条各自都有「页面上看不出异样」的
性质 —— 内容是错的、或者页面一直空着，而没有任何报错。

第二轮 3 条，全都是第一轮那几个修法自己带出来的后续，对应上表 9–11。其中第 10 条
按仓库 CLAUDE.md 的「同一类问题一次修干净」办：不是给漏掉的那个调用点补一行
`bumpSession()`，而是把它挪进 `start()`，让这一类漏法从此不成立 —— 顺带修掉了
`markPageExplicit()` 上同样的、还没有人发现的那一处。

第三轮 2 条，对应上表 12–13，同样都是前两轮的修法自己带出来的。第 13 条又按同一条
规矩办了一次：闩不加在换路由那个调用点上，而是收进 `start()`，因为「什么时候会重开
一轮」这件事只有 `start()` 知道全套；收进去之后顺着这条规矩往外找，又摸到
`revealHiddenTranslations()` 上同类的第二个洞。

第四轮 2 条，对应上表 14–15，两条都越出了自动翻译这一层：一条在整页翻译的批次池
里（`accept` 只拦回填，拦不住继续发请求），一条在翻译引擎的页面语言缓存里（单页
应用换页它不过期）。两条的修法都按同一条规矩落在**拥有那个东西的那一层**，而不是
在调度层换页的地方顺手补一下 —— 后者只在自动翻译开着的时候才管用，而划词、悬停、
字幕走的是同一条路。

第五轮 1 条，对应上表 16：那道「一跃跳走」的门是第一轮第 4 条的修法自己带出来的 ——
补门的时候只想着页面滚动，没想过候选会长在一个自己滚的容器里。

第六轮 3 条，对应上表 17–19。第 17、18 两条又都按「修在拥有那个东西的那一层」办：
「这块还算翻过吗」的答案属于**译文的身份**，不属于调度层的重启流程（所以手动整页
翻译一并修好）；「这块有结果了吗」只有翻译层知道，不该由调度层从「这一轮没报错」
反推（反推就会把失败读成成功）。第 19 条相反，是一条纯粹的名单遗漏 —— 但它顺带暴露
了一个结构问题：`content-bootstrap.js` 里那句「自动翻译要看五个键」的注释复述了调度层
的名单，于是名单一长它就过期。改成只说「名单在调度层」，并加一条钉子禁止转发那一层
出现 `RESTART_KEYS`。

第七轮 4 条，对应上表 20–23。这一轮里有两条是前一轮的修法自己带出来的后续：第 20 条
接着第 19 条往下走 —— 第 19 条补了四个键，仍然是「想起一个补一个」，这一次把**名单的
来源规则**写出来（凡是喂进「这一页翻不翻」或「这一块翻不翻」的设置键都得在里面），
并把钉子从「列字符串」改成「去那两个文件里扫出实际读到的键来对账」，于是这一类遗漏
从此不成立；第 22 条接着第 18 条 —— 记账改成等结果之后，那些「没走到结果」的块掉进了
一个没人管的缝里，而放回队列又必须有上限，否则一个稳定失败的接口就是一个每 250ms 一次
的死钱循环。另外两条各自独立：第 21 条是默认设置下最常见的一次死局（内置引擎 + 没装
语言包 → 整页停在 `ERROR`，装好包也不会自己活过来），第 23 条是排序的一个边角 ——
没有布局盒子的块算出来是 `-0`，和视口里的内容同一档，于是隐藏块把观察名额占满。

第八轮 2 条，对应上表 24–25，两条都是前几轮的修法自己带出来的后续，而且都是同一种
形状：**一个本该在某一刻定死的读数，被写成了「用到的时候再问一次」**。第 24 条是第 17
条的后续 —— 目标语言进了译文的身份，可那个戳是插入时现问设置拿到的，于是一轮跑到
一半改语言，旧语言的译文被盖上新语言的戳，下一轮理所当然地跳过它。改法是把「这一轮
译成哪门语言」收进一个 `passTarget()`，开跑时读一次，`request` 和 `stamp` 两个读数取自
同一时刻、一路带到落笔；`batch.js` 里三处 `targetLang: getEffectiveTargetLang()` 和
`insert.js` 里那一处 `ctx.currentTargetLang()` 全部让位，钉子直接禁掉这两个写法在那两
个文件里出现。第 25 条是第 21 条的后续 —— 预取的监听只在初始化时挂一次，换语言、换
引擎、单页应用换页之后它还挂着上一对，用户的下一次点击会去下**别的**包。

第 25 条的修法按仓库 CLAUDE.md 的「修在拥有那个东西的那一层」又办了一次：评审建议的
是「这些设置变化时重探一次并重挂」，那要在调度层的设置监听里复述一份「哪些设置会让
语言对过期」的名单 —— 正是第 19 条刚修掉的那个结构问题。实际改在引擎里：一次真实翻译
因缺包而失败的那两处，`src`/`tgt` 是现成的，就地挂上，三种过期情形全由它自然接住，一次
多余的往返都不花。顺着这条往外找，又摸到第三种同类的过期：划词和输入框弹窗上各有一个
一次性的语言下拉，用它译一句日文会让引擎拿着一个跟设置不同的目标语言撞上缺包 —— 那一对
挂上去必然被手势那道门拒掉，还顺手顶掉真正该挂的那一对。所以挂和触发问的是同一个问题
（`downloadTargetLang()`），且挂的那道门挡在「拆旧的」之前。

第 26 条不是评审提的，是这一轮收尾那次「把整个改动当成一个 diff 再读一遍」读出来的：
第 25 条把预取写厚之后，引擎越过了 1k 行线。见上表 —— 拆出去的是**层次放错了的那一块**，
不是「最长的那一块」。

第九轮 1 条，对应上表第 27 条，又是同一种形状的后续 —— 这次是**同一个问题，两端给的答案
不一样**。第 17 条把「这块还算翻过吗」改成问译文的身份，但只改了收集端；落笔端那道重复门
还是原来那句 `classList.contains('ai-translator-translated')`。两端之间隔着一次网络往返，
而两轮翻译完全可能同时在飞（用户在手动那一轮跑着的时候改了目标语言），于是先落地的旧语言
译文让后到的新语言译文被静默拒收，调用方却照样记账。修法就是把收集端那三行搬过来，两端从此
同问同答；修法就是把收集端那三行搬过来，两端从此同问同答 —— 只是搬的时候没带上裁决者，
见第 28 条。这一条和第 28 条共用一组钉子：源码守卫，加四个真跑 DOM 的行为测试
（`test/e2e/page-translation-restamp.spec.js`：我们这条是当前语言就换掉、不是当前语言
就不动页面、同内容同语言仍然去重、没人说语言也去重），三处变异（门改回只看 class、
裁决者退回「不一样就换」、去重那一问删掉）各自让对应的那一条变红。这组测试**必须让两轮
都在任何译文落地之前就收走这一块** —— 收完第一条译文再收第二次的话，收集端自己那道陈旧
判定会先把旧译文摘掉，落笔端根本碰不到这一局，三处变异全都照样绿。

第十轮 1 条，对应上表第 28 条 —— 第 27 条自己带出来的后续，而且是**同一场竞速的反方向**。
第 27 条把落笔端从「一律拒收」改成了「语言不一样就换掉」，两个极端都错：前者让后到的
新语言译文写不进去，后者让后到的旧语言译文把新的盖掉，两条路通向同一个终点（页面停在
旧语言，且再没人动它）。只比两方就只能比出先后顺序，而先后顺序是网络说了算的 —— 所以
这一轮补的是**第三方**：此刻这一页该译成的那门语言。三方一比，两个方向同时闭合。

顺着这一条往回看，第 24 条那句「落笔端不许现问设置」也得改口径：它禁的本来就不是
「问」，而是「拿现问的答案当戳」。钉子于是从整份文件禁 `currentTargetLang` 改成
「只许出现在裁决者那一个函数里」—— 范围缩小了，禁的那件事反而说得更准。

相应的钉子加在 `auto-translate-wiring.test.mjs`（现 30 条）和 `block-identity.test.mjs`
（第 17 条的三条行为测试：换语言判陈旧、两头都能退回从前、文字变了一票否决；第 27、28 条
又添一条落笔端守卫）。第 12 条还加了 e2e 的
咬合：`auto-translate-basic` 的夹具里补了一段**带内联链接和强调、正文缩进在标签里边**
的正文 —— 原来那三段都是光秃秃的 `<p>text</p>`，两个表示法碰巧长得一样，所以这条
P1 在三轮评审之前一路绿着过来。

**PR-6 的三条出口 e2e**（`test/e2e/auto-translate-{basic,incremental,spa}.spec.js`）都做过变异
验证：把路由接线注释掉，`spa` 第一条挂；把视口带放大到 10000px，`incremental` 挂；把开跑前
那次比对换回 `fingerprint(block.text)`，`basic` 第一条挂在新补的那段带标记的正文上；把滚动
那道门换回只看 `window.scrollY`，`incremental` 新补的那条挂。
断言咬的是它们该咬的东西，不是碰巧变绿。

第六轮的两条也各自补了一条**做过变异验证**的 e2e，都在 `auto-translate-basic`：
换目标语言那条（把 `isStale()` 的语言这一维改成永远不问 → 挂），和「一批失败了下一次
还得再试」那条（把记账挪回发出去那一刻 → 挂）。后者要造的是「一半成一半败的一轮」，
所以 `mock-openai-server` 多了一个 `failRequests` 选项：让最前面几次请求以 500 作答，
之后恢复 —— 整台服务器一直 500 造不出这种局面，那是另一条路（整体故障）。第 19 条
没有单独的 e2e：重启这条路本身已经被换目标语言那条咬住，剩下的是一份名单里有没有这
四个字符串，钉在单元测试里更准（连拼写一起钉）。

最后这条变异第一次跑的时候**两边都绿**，是它自己不作数：装载时排的那次重排（400ms 的
定时器）正好落在跳转之后才去量几何，量到的是跳完的位置，于是最后一条被那次重排顺手
捎上了 —— 滚动监听整个坏掉也照样通过。所以跳转之前先等这一轮停稳（连着一秒多没有新
请求发出去），再跳。**这类「等一个定时器不在飞」的等待，等的必须是能从外面看见的东西**
（这里是请求条数），不能是写死的睡眠。

第七轮的四条钉子也都做过变异验证，都在 `auto-translate-wiring.test.mjs`：抽掉
`ctx.onLanguagePackReady` 的导出 → 第 21 条挂；抽掉 `retried.add(pending.key)` → 第 22
条挂；从 `RESTART_KEYS` 里删掉 `skipTargetLanguageText` → 第 20 条挂；去掉没有布局盒子
那道 `Infinity` 护栏 → 第 23 条挂。这四条都没有单独的 e2e：第 20、22 两条要造的局面
（改设置、接口半成半败）已经分别被第 17、18 条的 e2e 咬住，第 21 条要的是一台没装过
语言包的机器，第 23 条要的是一段 `display:none` 的折叠内容配上超过两千个候选 —— 这三种
在浏览器里造出来的成本远高于它们能多咬住的东西，而它们真正的风险面（导出名字、上限
存在与否、护栏存在与否）在源码这一层钉得更准。

第八轮的 9 个钉子同样逐个做了变异验证，都在 `auto-translate-wiring.test.mjs`：戳改回现问
设置、请求改回现问设置、插入时不带语言 → 第 24 条挂；去掉同一对的短路、删掉一处缺包时
的重挂、去掉手势触发时的复核、去掉挂的时候那道门 → 第 25 条挂；把新模块从 manifest 里
删掉、让它伸手去拿引擎的 `SUPPORTED_LANGS` → 第 26 条挂。每一次都确认套件变红，
再还原确认 502 条全绿。这一轮也没有单独的 e2e：第 24 条要造的是「一轮跑到一半改设置」，
得卡在一个在飞的批次上（改在两轮之间的那种已经被第 17 条的 e2e 咬住，而那正是这条 P2
能一路绿着过来的原因）；第 25 条要的仍然是一台没装过语言包的机器。两条真正的风险面 ——
一轮里读几次设置、挂着的那一对会不会过期 —— 在源码这一层钉得更准。

第九轮那一条的验证同样是变异式的：把落笔端的门改回只看 class，以及保留判据但删掉「摘旧的」
那一步 —— 两种都让 `page-translation-restamp` 的第一条变红，而后两条（去重仍然要成立）保持绿。

### PR-7 第五轮的三条

评审指出的三条都属实，但第三条只接受了一半，理由写在这里而不是只留在 PR 评论里：

1. **popup 上那一行印「继续」的时候，页面那边真的得继续。** 页面的 `resumeCurrentPage()`
   从一开始就收 `PAUSED` 和 `ERROR` 两种，popup 却只认 `paused` —— 于是出错的那一页上按钮
   印着「暂停」，点下去把 `ERROR` 变成 `PAUSED`，用户得重开 popup 再点一次才轮到重试，而
   出错的那一页正是最需要一下点中的。两边共用一个 `AUTO_RESUMABLE`，钉在
   `auto-status-wiring.test.mjs` 里同时比对两处源码。
2. **和弦可以来得比「动手」还晚**（见 §5.6 的补充）。e2e 补了一条旅程：按住 Alt 译出一段，
   手不松再按 A，之后划过的段落一段都不许再译；变异掉那一行补刀，这条旅程当场变红。
3. **`siteRules` 会无限长下去** —— 属实，同步存储每项 8KB，撑爆那天 `set()` 直接失败。
   但**不分片**：分片会把一个六处都在读的结构换掉，而且真正的风险不是表太大，是用户亲口
   说过的话被程序扔掉。所以做两件事，都不改 schema：
   - **只在超预算时**收掉「收了也查不出差别」的条目（`compactUserRules`）。多余不靠眼力
     判断，靠再查一遍：删掉之后 `lookupUserRule` 对这个键的答案没变，才真的多余。这样
     `x.com=always` 底下的 `ads.x.com=never`、以及 `localhost` 下面的单标签主机都不会被
     误收。不平时清理，是因为子域那条今天多余不等于明天多余：用户哪天把父域改成相反的
     状态，留着的那条还护得住那个子域，平白收掉了就跟着变 —— 一次没人看见的改主意。
   - **写不进去就让失败传出去**，popup 上说一声（`popupSiteRuleFailed`）。那个开关是乐观
     控件，它已经在用户眼里动过了；吞掉失败就是「按钮动了、设置没存上」。
   真正的泄压阀是 PR-10 那张**每条可删**的审计表，已经写进上面的 PR 清单。

### PR-7 第六轮的三条

三条都属实，三条都改了。共同点是「同一下点击顺手做了第二件事」：

1. **黑名单那一行是死的，不是关着的。** 阶梯上 `isBlocked()` 和内置 `never` 排在所有站点
   规则前面（`site-rules.test.mjs` 的「the blocklist outranks the user own always」就是这
   条），所以在 `mail.google.com` 上把那一行点开，写下去的 `always` 一辈子也生效不了。点
   了没反应还不是最糟的 —— 最糟的是这一下**顺手把总开关打开了**：他要的是眼前这一个站点，
   拿到的是整个浏览器。现在按钮灰着（`.menu-item:disabled` 早就有），`title` 上写着为什么
   （`autoReasonBlocklist`，十个语言都已经有），`toggleSiteAuto()` 里再挡一道 —— 键盘走得
   到 disabled 的按钮，扩展页面也点得动。
2. **站点规则先落地，总开关才跟着开。** 原来的顺序是反的，于是规则写失败（上一轮那条配额）
   的时候总开关已经替所有别的站点开好了。反过来漏掉的那半边不伤人：规则落了地而总开关没
   开，再点一次就补上。
3. **长按的尾巴由那一下合成事件自己宣布，不由秒表宣布。** 触屏菜单 500ms 就开出来了，手指
   常常还按着；松手时补发的那一串合成事件如果晚于一秒的窗口，就一路落到最后一档，把整页
   翻译也点了 —— 一次长按，开菜单外加一次花钱的整页翻译。改成按手势记一面旗
   （`longPressFired`），由合成的那一下 mouseup 消费掉，下一次 `touchstart` 兜底清掉，所以
   合成事件万一根本不来（长按被系统手势截走），旗也烂不过这一次手势。

第三条补了一条真·浏览器旅程（CDP `Input.dispatchTouchEvent` + 触摸模拟，这套件里第一次用
触屏）：长按开菜单、再按满 1.6 秒、松手，翻译请求必须是 0 条。把实现变回秒表窗口，这条旅程
当场变红 —— 那次没人点过的整页翻译是真的会发出去。前两条是 popup 的接线，钉在
`auto-status-wiring.test.mjs` 里（去掉灰、去掉闸、把顺序换回来，三种变异各让一条变红）。

### PR-7 第七轮的一条

上一轮那道黑名单闸问错了人：它读的是 `auto.reason`，而 `decide()` 第一档就
`GLOBAL_OFF` —— 总开关关着时黑名单被整个遮住，闸不响。而那恰恰是这个开关最该灰着的
时候：点下去写的是一条永远生效不了的 `always`，还顺手把总开关替所有别的站点打开了。

修法不是在 popup 里再判一遍（popup 手上没有内置表，它的 `location` 是
`chrome-extension://`），是把这一问**单独立成一个主人**：`SiteRules.isBlocklisted()`
—— 黑名单表和内置表里的 `never` 是同一件事的两种写法，对外只有一个说法，`decide()`
自己的那一档也换成问它。页面在 `AUTO_PAGE_STATE` 里把答案单独回一句（`blocked`，
跟 `host` 一样「只有页面答得了」），popup 照着它灰。

钉住两头：`site-rules.test.mjs` 里一条行为断言 —— 总开关关着时 `reason` 是
`GLOBAL_OFF` 而 `isBlocklisted()` 照样答 true，并且逐个探针比对它和阶梯的答案必须
一致；`auto-status-wiring.test.mjs` 里 popup 不许再出现 `reason === 'BLOCKLIST'`，
也不许自己调 `isBlocklisted`。三种变异（popup 读回 reason、`isBlocklisted` 丢掉黑名单
那一半、页面不回这一句）各自变红。

### PR-7 第八轮的一条

`translateCurrentPage()` 那道 key 门开得太宽：这一页已经有译文时，那一下是收起来 /
放出来，动的是 DOM，一个请求都不发 —— 却照样被没填 key 的自定义引擎拦下，按钮上写着
「收起译文」，点下去弹出的是设置页，译文还在原地。用内置引擎译完、事后把引擎换成自定义
的人，从此连自己那一页都收不起来。门改成只对「真要开译」的那一下开，判据还是页面回的
那一份 `hasTranslations` —— 和按钮上那行字用的是同一个事实，不另立一套。

### PR-7 第九轮的两条

**一、译文藏着的时候，那个站点开关关不掉。** 「我想看原文」把这一页停在 `paused`；
popup 上那一行画的是**状态**，`paused` 不是 `off` 也不是 `ask`，于是它写着「开」。
点一下写 `never` 落盘，规则变动确实重开了一轮 —— 可 `start()` 第一件事就撞上隐藏闩，
原地返回，`status`/`reason` 都还停在上一次。那一行重画出来还是「开」，再点一次又写一遍
`never`，怎么点都关不掉。

闩拦的本来就只是**开始翻**，不是**重新判**。所以它先 `resolve()` 一次再返回：判出
`off` 就如实说 `off`（这一页往后也不会自己翻了），还该翻的照旧停在 `paused`。一行翻译
也没多跑 —— `setStatus` 紧跟着 `return`，这件事由 `auto-translate-wiring.test.mjs`
那条老断言换个形状继续钉。加了一条真旅程：译好、藏起来、从服务工作者走 popup 那条同样的
写入路写 `never`，状态必须从 `paused` 变成 `off`，而译文还藏着、请求数一条不增。把闩改回
原地返回，这条旅程当场变红（`Expected "off" / Received "paused"`）。

**二、第八轮那道 key 门漏了「藏着」这一种。** 判据写的是「有译文就不花钱」，可页面那边
`togglePageTranslation()` 在译文藏着时走的是 `translatePage()` —— 放出旧译文的同时，把
这一页藏起来之后新长出来的块补上，那些块要花钱。没填 key 的自定义引擎照样会被放进去跑一趟
必然失败的翻译。

「这一下是不是收起」于是也归一个主人：`isHideAction()` —— 按钮上那行字和这道门问的是同
一句，`hasTranslations && translationsVisible` 两个条件缺一不可。一处定义、两处用，这件事
本身由测试数着（多一处就是又立了一套）。

### PR-7 第十轮的三条

**一、后台标签页把追问的三次机会花光了。** `render()` 一判出「这一页该问」就去领号，而
中键点开的那一串链接、浏览器预渲染的那一份，内容脚本一样跑完 —— 条子在那些标签页里谁也
没见过，号却照领。三次机会可以在用户面前一次没露过的情况下用光，这个域名从此永远安静，
而他只会觉得这个插件在这儿坏了。

领号前先问一句 `document.visibilityState === 'visible'`：看不见就不领，条子照旧收走。
「等它真被看见了再领」需要有人来叫第二遍 —— `visibilitychange` 重画一次，预渲染转正走的
也是这个事件。

这一条在浏览器里证不了：无头 Chromium 把每个标签页都报成 `visible`，CDP 也没有覆盖它的
命令（`Emulation.setPageVisibilityOverride` 早就不在协议里了）。所以它钉在
`test/unit/auto-status-wiring.test.mjs`：闸门那一句和那个监听器，两半都钉。

**二、用户按下的暂停，别人改一条规则就能顶开。** `pauseCurrentPage()` 只改调度层的
`status`，而 `status` 会被下一次 `start()` 盖掉 —— 而 `start()` 常常是别人替他叫的：另一个
标签页在追问条上勾了「总是」，`siteRules` 一落地，这一页的 `onSettingsChanged` 就重开一轮。
他按下的暂停当场失效，页面自己又翻起来，而他没有碰过任何东西。

所以暂停记成一道闩 `pausedByUser`，和「藏起译文」并列在 `start()` 的同一个判断里。解闩的
只有他自己后说的那两句：**继续**（`resumeCurrentPage`）、**翻译整页**（`markPageExplicit`）。
后者还得连带重开一轮 —— 哪怕这一页早就表过态（`explicit` 已经是 `true`），那一轮正停在
闩上，不重开就等于什么都没发生。

**三、球上那两颗按钮键盘够不着。** 状态点和 `···` 都是 `<span role="button">` —— 既不进
Tab 序，也不认 Enter，而本文档自己那一行写的是「追问条、状态点、popup 四行均可 Tab / Enter
操作」。

两颗都换成真的 `<button type="button">`，Enter/Space 在球上那个 `keydown` 里派活：落在哪
一颗上仍旧问 `pressZone()`（鼠标那条路问的是同一个），并且 `preventDefault()` 把 `<button>`
自己合成的那一下 `click` 挡掉 —— 不挡的话，将来谁在球上挂一个 `click`，一次按键就点两回。

配套的三件小事：`···` 平时 `opacity: 0`，所以显形那条规则要连 `:focus-within` 一起认，否则
Tab 停在它身上时人看到的是焦点凭空消失了一格；状态点没有文字，`aria-label` 和 `title` 说的
必须是同一句（都是 `explainLine()`）；`···` 是开合菜单的按钮，`aria-expanded` 得跟着菜单走。

**「Esc 关掉菜单」没有在这一层再写一遍。** `content/content-selection.js` 那一处统管所有浮层
的 Esc，它本来就连着 `ctx.hideFloatMenu()`。这一层只补它管不到的那半件事：菜单一撤，焦点
如果正在菜单里，就掉回 `<body>` 了 —— 送它回 `···` 上。鼠标点别处关的不算，那时候焦点本来
就不在这儿，抢回来是打断。

### PR-7 第十一轮：闩是「这一页」的

第十轮那道闩只补了一半。`onRouteChange()` 把 `explicit` 归零（新的一页，用户还没表过
态），却没归零 `pausedByUser` —— 于是他在一篇文章上按下的暂停，跟着他走进了单页应用里
的下一篇、下下篇。他按的那句话是「**这一页**先别翻了」；「这个站点从此别翻了」有另一个
说法，就是 popup 上把站点关掉（写 `never`）。

更糟的是他没有任何理由想到要去解：唯一的那颗「继续」按钮此刻指着的是他早就离开的那一
页，而新的一页看起来只是安静地没有翻译。

所以 `onRouteChange()` 里两样一起归零。单元测试把解闩的地方钉成了三处
（`resumeCurrentPage` / `markPageExplicit` / `onRouteChange`），多一处就红 —— 每多一条自己
会解闩的路，都得是有人特意写下的。e2e 那一条在 `test/e2e/auto-translate-spa.spec.js`：
`/abs/2401.00001` 上暂停，`pushState` 到 `/abs/2401.00002`，新文章照常翻。

### PR-7 第十二轮：两处「同一个问题两个答案」

**一、显隐开关收走了划词译的那一句。** `setTranslationsVisible()` 用的是宽选择器
`.ai-translator-inline-block`，而划词和悬停的译文块用的是同一个类名（只多带一个自己
的）。于是「我想看原文」这一下把用户刚刚指着一句话问出来的答案也收走了 —— 更糟的是
插它的那条路（`content-hover-translation.js`）根本不读 `state.translationsVisible`，
所以他再划一句，新的答案照样冒出来：藏旧的、不藏新的，这个开关在他眼里就是时灵时
不灵。

这个文件里本来就有一条说了算的判据 `PAGE_TRANSLATION_SELECTOR`（「仅显示译文」的逐条
计算和 `hasPageTranslations()` 用的都是它，后者的注释里写得很清楚：用户划词译了一句，
这一页并不因此就「翻过了」）。显隐开关只是没收到这份通知。现在三处同一条，常量也从
文件中段挪到了顶上 —— 它是这个文件的中心定义，不该藏在 `CROWDED_ATTR` 后面。

**二、popup 把 `pending` 画成「开」。** 走到 `PENDING` 的**前提**就是第一问已经答了
`ask`（`off` 和 `auto` 都当场返回了），而第二问带上语言之后，`decide()` 的阶梯上剩给它
的只有 `off`（同语言 / 不在语言名单里）和 `ask` 两条 —— 再没有一条通往 `auto`。所以一个
`pending` 的站点**永远不会**变成「在自动翻」。

代价不是画错一瞬：popup 问完就不再听了，这个字会一直错到它关掉；而用户照着那个「开」
点一下，写进去的是一条**永久的 `never`**。

`AUTO_ACTIVE` 去掉 `pending` 之后，站点行的「开 / 关」和暂停行的「在 / 不在」问的成了同
一件事，所以合并成一个出处：`siteAutoOn(status)`，画这一行和点这一行共用。原来那句
`globalAuto && status !== 'off' && status !== 'ask'` 在两个函数里各写了一遍，这正是它
们会分家的原因。单元测试把 `decide()` 末端那两行 `ask` 也钉住了 —— 那是上面整段推理的
依据，它一变，`pending` 的含义就变了。

### PR-7 第十三轮：受管容器里的那一句，和「谁停的谁解」

第十二轮把「划词译出来的一句不归整页开关收」写进了 `PAGE_TRANSLATION_SELECTOR`。评审
指出那一条在**受管容器**（Lexical / ProseMirror / PDF / 漫画）里落不到实处，顺带又指出
显隐层那一停一续越权撤销了 popup 上按下的暂停。两条都真，而第一条往下挖出了同一处的另
外两个缺陷。

**一、受管容器里的译文没有节点可以排除。** 它是原文块的 `::after`，显隐靠挂在 `<html>`
上的一个属性整体开关 —— 那个属性会把**所有**受管译文一起关掉，包括刚划词问出来的那一
句；而且它管的是生成内容，**接下来新划的一句照样不出来**，直到整页译文重新显示为止。

修法和普通容器一致：原文块上打一个 `data-ai-translator-managed-one-off`，隐藏规则改成
`[hidden] [managed]:not([one-off])::after`。判据只有一条 —— **句柄自己答不答得上
`PAGE_TRANSLATION_SELECTOR`**。这里再按 `kind` / `className` 自己判一遍的话，两处迟早
各答各的。

写验收旅程时发现这个场景**当时根本走不到**，底下压着两个缺陷：

- `canRenderManagedTranslation()` 把**我们自己上一笔**当成了站点的 `::after` 装饰。一条
  译文从「正在翻译…」变成正文，就是在同一个块上再画一次；第二笔因此永远落不下去，
  受管容器里划词一直停在「正在翻译…」，然后退回那条插真节点的路 —— 而那条路在 Lexical
  里下一帧就被编辑器撤销，用户什么都看不到。现在先问 `BLOCK_ATTR`：这个块归不归我们管。
- 换一条译文是「先画新的、再收旧的」（`trackInlineTranslation`）。两个句柄共用同一个
  id，旧句柄一释放，规则和块上的标记全被收走 —— 刚画上去的那条当场消失。现在记
  `currentHandle`（块 → 句柄），旧句柄只收自己。

**二、显隐层越权撤销了暂停。** 「这一页先别翻了」和「我现在想看原文」是两句话。显隐那
一下顺手停、顺手续都对，但能撤销的只有它自己停的那一下。原来那条路无条件解闩：用户在
popup 上按了暂停，再从悬浮球菜单看一眼原文、切回译文，页面就自己又翻起来了 —— 而他从
头到尾没碰过那颗按钮，也没有任何理由想到要再去按一次。

`pauseCurrentPage(cause)` / `resumeCurrentPage(cause)` 现在要问是谁停的：`'hidden'` 那一
停**不上闩**（`start()` 看的是 `ctx.state.translationsVisible`，那一道已经拦着了），那一
续也不解闩，闩还在就原地停住。popup 那两下不带 `cause`，照旧是用户自己说了算。

验收：`受管容器：整页译文藏着的时候划词，那一句照样看得见`、`popup 上按下的暂停，不会被
「显示原文 → 显示译文」顺手洗掉` 两条旅程，外加 `managed-dom-root` 与
`auto-status-wiring` 里的四处钉子。四处改动逐条反向验证过：每去掉一处，对应的旅程或单测
立刻变红。

### PR-8：规则表到收集器之间多了一层

§11 的 PR 清单里 PR-8 只写了两个文件（规则表 + `collect.js` 的原子块）。落地时在中间加
了一个新模块 `content/page/site-adapter.js`（71 行），`manifest.json` 里排在 `batch.js`
之后、`collect.js` 之前。它只做一件事：把当前页命中的那条内置规则，解析成 `atomic` /
`exclude` 两串选择器，按 `host + path` 缓存。

分出来的理由有两条，都不是风格问题：

- **规则表是会随版本更新的数据，而 `matches()` / `closest()` 在 `processElement` 的热路
  径上。** 表里一个写错的选择器会让这两个调用当场抛，那是整页零块、静默翻不了。所以
  每串选择器先拿 `document.querySelector` 试一次，抛了就当这条没写过——坏掉的退化方向
  是「翻得碎」，不是「翻不了」，和 `shared/site-rules.js` 的 `loadTable` 同一个精神。
  这段校验逻辑放进 `collect.js` 会把它挤得更长（本来已经 852 行）。
- **`globalThis.SiteRules` 不进 `collect.js`。** `block-identity.test.mjs` 和
  `fast-batch-alignment.test.mjs` 都把 `collect.js` 装进一个极简假 DOM 里跑，多一个全局
  读就多一个桩。

`collect.js` 这边只有两道门各加一个词：`!atomic && hasTranslatableChildren(...)`（原子块
不下探）和 `atomic || blockTags.includes(...)`（推文正文是个 `<div>`，直属文本为空，两个
原条件都不成立）。内联分支**故意不动**——原子的内联元素本来就被整块推出去，超过 500 字
时落到块级分支，`atomic` 在那里接住它。

`test/e2e/helpers.js` 的 `PAGE_TRANSLATION_MODULES` 要跟着加三个文件
（`shared/site-rules-builtin.js`、`shared/site-rules.js`、`content/page/site-adapter.js`）。
漏掉不会红在守卫上：site-adapter 对 `globalThis.SiteRules` 是运行时软读，拿不到就安静地
退回通用启发式，站点规则的 spec 会全变成「翻是翻了，只是没按规则翻」。

验收：`test/unit/site-adapter.test.mjs` 七条（含坏选择器只丢自己那一条、全坏读成
无规则、缓存跟路径走），`test/e2e/page-translation-site-rules.spec.js` 四条（X / HN /
arXiv / old.reddit.com）。四条 e2e 逐条反向验证过：把 `ctx.resolveSiteAdapter` 换成
`() => null`，四条全红。

### PR-9：字幕面接入

本文 §8 说的是「复用」，落地时有五处不同。

**1. 闸门用 `siteRefused`，不是 `siteAuto`。** §8 原说字幕这一面跟着整页那一面的
结论走。真接上去发现它在最该生效的地方永远是 false：`SiteRules.decide()` 的阶梯里，
youtube.com 既不在拦截名单、也不在内置 `always` 名单，答案是 `ask`，于是
`siteAuto` 恒假 —— 拿它当闸门，替观众点开原字幕这件事在 YouTube 上一次也不会发生。
要问的是另一句话：「这个站点是不是**明令拒绝**了我们自己动手」。那三条
（总开关关着、在拦截名单里、用户对这个站点说过 never）现在由
`shared/site-rules.js` 的 `REFUSALS` 定义，`decide()` 的返回值多一个 `refused`
字段。**分类留在 SiteRules 里，调用方只读 `.refused`** —— 否则每个调用方都得把理由
表重述一遍，而 `auto-translate-wiring.test.mjs` 的守卫正是在防这个（它不许调度层里
出现 `blocklist`/`isBlocked`，第一版写法撞上了，撞对了）。

**2. `autoEnableCaptions` 是本轮唯一保留的独立开关。** UX 设计反复说的是「少一个
开关」，这一个留下来，因为它和其余的自动化不是一类事：别的都只是往页面里插我们自己
的节点，它**改动播放器自己的状态**（YouTube 的 CC 按钮、一条 `<track>` 的 mode）。
有副作用的那一件事要单独同意。默认关 —— 关着的时候，字幕这一面和从前一模一样。

**3. 那道闩只合不开，而且不问是谁开的。** 心跳 1.5 秒一拍，所以「观众关掉、我们点
回来」不是打扰，是他**关不掉**。`syncNativeCaptions()` 因此记两件事：`sawNativeOn`
（看见开着，按视频清）和 `autoEnableBlocked`（看见开着之后又看见关了，按会话留）。
第一版写了三个标志，想分清「我们开的他关掉」和「他本来就开着又自己关掉」——想清楚
之后发现这个区分是错的：在他眼里是同一件事，而且分错一次的代价就是上面那个打扰。
越过闩只有一条路：菜单里的「开启原字幕」，那是他自己按的。

**4. 往前译加了窗，而且只给花钱的那条路加。** §8 没提窗口，原实现是整条轨道译到
底。内置引擎免费且本地，窗是 `Infinity`（不设）；云端那条路默认 5 分钟，在「只看
原文」模式下缩到 30 秒 —— **缩不是停**，切回双语要立刻有译文。
`translationWindowMs()` 是这三句话的唯一出处。

**5. 顺手修了一个既有的真 bug。** `getCueKey(cue)` 是在 await **之后**算的，读的是
当时的 `state.trackId`：上一条轨道的译文晚到，会用新轨道的 key 存进缓存 —— 而且因为
key 是合法的，这批错语言的译文再也不会被重译。现在 trackId 和 sessionVersion 在发
请求时就捕获，对不上就整批丢掉。另加 §8 要的长度守卫
（`translations.length !== cues.length` → 走既有的冷却重试）；`parseNumberedResponse`
在所有分支上都恰好 push `expectedCount` 条，所以这道守卫不会误伤既有的 mock。

**6. 状态行问的是「候选」provider，不是「已接上」那个。** 按钮在功能关着的时候也
要在（那正是它的用处），而那时 `state.provider` 是 null —— 第一版的
`captionStatus()` 走的是引擎内部的 `isCaptionsEnabled()`（读 `state.provider`），
于是一个原字幕开得好好的 YouTube 播放器会被说成「原字幕还没开启」。现在问的是
`syncControls()` 传进来的那个候选 provider，而且**拿不准就当它开着** —— 宁可少给
一条路，不要给一条按了没反应的。

**7. 「按了个空」要记下来，否则 1.5 秒后同一个死按钮又摆回来。** YouTube 在没有
字幕的视频上把自己的 CC 按钮 disable 掉，`enableNativeCaptions()` 于是返回 false。
第一版由菜单自己把状态行改成「未检测到字幕轨」，但下一拍心跳 `sync()` 会把
`ui.info` 整个覆盖掉，那句话活不过 1.5 秒，按钮回来，按下去还是没反应。改成引擎记
一个 `nativeUnavailable`（按视频清，原字幕一开起来就清），菜单那边因此**一行状态都
不用自己造** —— `ctx.enableNativeCaptions()` 返回前已经 `syncControls()` 过了。

**8. CSS：`[hidden]` 在这个菜单里藏不住东西。** 这是本轮唯一一条「按情况露出来」的
菜单项，而 `[hidden]` 的 `display:none` 只是 UA 规则，`.ai-translator-caption-menu-item`
自己那条 `display: flex` 一来就把它压掉了 —— JS 照样置 hidden，屏幕上那一行纹丝不
动（e2e 抓到的：Playwright 说它 visible，DOM 里 `hidden=""` 明明在）。菜单根节点早
就为同一件事单独写过一条，这是第二处，由 `caption-core.test.mjs` 钉住。
