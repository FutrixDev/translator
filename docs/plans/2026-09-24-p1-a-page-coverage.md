# P1-A 页面覆盖：iframe、Shadow DOM、notranslate、正文范围

- 日期：2026-09-24
- 基线：`origin/main@8a10465`（manifest 1.4.0）
- 所属：P1 功能对标回合（台账 D-291），对标沉浸式翻译，只补功能
- 交付：一个 PR `feat/p1-a-page-coverage`，由两批并行拼装——A1 frames（`feat/p1-a1-frames`）、A2 Shadow DOM + notranslate + 正文范围（`feat/p1-a2-shadow-scope`）

## 0. 结论

今天整页翻译只看得见**顶层文档的 light DOM**：iframe 里的正文（嵌入的文章、评论区、文档站的示例框）一个字不翻；Web Components 站点（shadow root 里的正文）一个字不翻；页面标了 `translate="no"` 的品牌名、代码标识照翻不误；导航栏、侧栏、页脚和正文一起翻——多花钱，还常把横向导航挤坏。

这一轮补四件事，每件都有一个明确的边界：

| # | 能力 | 边界（刻意不做的） |
|---|---|---|
| 1 | **iframe**：整页翻译连同子 frame 一起翻；自动翻译时子 frame 跟随顶层 | 广告/验证码/支付/登录/播放器 frame 一律不进；过小、隐藏的 frame 不翻；子 frame 不画悬浮球、追问条、popup 状态 |
| 2 | **Shadow DOM**：open root 与 closed root（`chrome.dom.openOrClosedShadowRoot`）都收；译文样式带进 shadow 树；新长出来的 shadow 内容跟着翻 | 受管容器（`::after` 渲染）在 shadow 树里不支持，照旧走普通插入 |
| 3 | **notranslate**：`translate="no"` 与 `.notranslate` 元素级生效，最近一层说了算，`translate="yes"` 可在里面重开；行内的不译元素原样保留在译文里 | `<html translate="no">`、`<body class="notranslate">`、`<meta name="google" content="notranslate">` 这类**文档级**声明不认 |
| 4 | **正文范围**：默认只译正文（`pageTranslateScope: 'main'`），导航、侧栏、菜单、文章外的页眉页脚不翻；设置里可改成整页；另有「翻译整个页面」入口（Alt+W + 悬浮球菜单一项） | 内置站点规则命中的页面照旧整页译（那些规则是按整页调出来的） |

### 0.1 自决（台账 D-291 已登记，此处给依据）

| # | 裁定 | 依据 |
|---|---|---|
| 1 | 默认 `pageTranslateScope = 'main'` | 对方默认只译主要内容、另给整页入口；少翻导航省钱（自动翻译时尤其明显）；导航/菜单是最容易被译文挤坏布局的区域（现有 `horizontal-nav` 一类修补就是证据）；判不准时退回 body 并只跳明确的非正文语义（nav/aside/菜单、文章外的页眉页脚），不会出现「整页什么都不翻」 |
| 2 | 子 frame 的引擎请求经服务工作者转给顶层 frame 执行 | Translator API 只在顶层与同源 iframe 可用（Permissions Policy）；统一中继还能共用顶层的模型实例、缓存、每日 AI 额度闸。代价：子 frame 里的手势不能触发模型下载（已知限制，见 §5） |
| 3 | Shadow 树里的译文样式：服务工作者读 `content/css/translation.css` 文本，内容脚本做成 constructable stylesheet 挂进 `adoptedStyleSheets`；没有 `<style>` 退路（整合回合删去：两条路只有一条被测，装不上就打一条日志） | manifest 没有 `web_accessible_resources`，内容脚本 fetch 不到扩展内文件；不为此新增 WAR（会把扩展文件暴露给所有网页） |
| 4 | 新命令 `translate-whole-page`，建议键 Alt+W；悬浮球菜单加「翻译整个页面」 | P1 在 manifest `commands` 上只许新增一条（Alt+A 已占）；快捷键 + 菜单项两个入口覆盖键盘与鼠标用户 |
| 5 | notranslate 只认元素级 | 很多站点在 `<html>` 上声明 `translate="no"` 只是为了压住 Chrome 自带的翻译条；用户主动调用我们时要的是翻译。元素级声明才是「这几个字别动」 |
| 6 | 广告/验证码/支付/登录/播放器 iframe 静态拒入（不建 ctx，即 dormant），过小/隐藏 frame 翻译时按尺寸判 | 静态拒入省掉整个 ctx 的初始化成本，并保证支付/登录 frame 里永远没有我们的节点；尺寸是动态的（懒加载 frame 先 0×0 后撑开），只能在要翻的那一刻判 |
| 7 | 服务工作者只做**无状态路由**；子 frame 登记表放在顶层 frame 的内存里 | MV3 服务工作者随时会被回收，登记表放它身上等于随机丢失；顶层 frame 与页面同寿命 |
| 8 | 子 frame 自动翻译的阶梯：先问**自己的主机**是否被拒（黑名单 / 内置 never / 用户 never），被拒则不翻；否则跟随顶层指令。手动整页翻译时子 frame 与顶层 `translatePage()` 同口径：不问阶梯，直接翻 | 用户对某个站点说过 never，这个站点被嵌进别处时也不该翻；而顶层手动翻译本来就不问阶梯 |
| 9 | 漫画、PDF 提示、视频字幕、语言包预取、悬浮球、追问条只在顶层 | 这些都是「页面级」功能；嵌入播放器里的字幕翻译进 backlog |

## 1. 现状（file:line）

| 位置 | 现状 | 本轮 |
|---|---|---|
| `manifest.json` `content_scripts[1]` | `<all_urls>`、`document_end`、78 个 JS / 12 个 CSS，无 `all_frames` | A1 加 `all_frames` / `match_about_blank` / `match_origin_as_fallback` |
| `manifest.json` `commands` | 只有 `toggle-translate-page`（Alt+A） | A2 加 `translate-whole-page`（Alt+W） |
| `content/content-bootstrap.js:191` | `ctx.init` 无条件跑全部初始化（`:201` 悬浮球 … `:220` 漫画续跑） | A1：dormant 闸 + 子 frame 裁剪初始化 |
| `content/content-messaging.js` | `setupMessageListener()` 不分 frame，谁先回谁算 | A1：子 frame 不回顶层专属消息；A2：加 `TRANSLATE_WHOLE_PAGE` |
| `background/background.js:294-299` | `onCommand` → `tabs.sendMessage(tab.id, TOGGLE…)` 不带 frameId | A1 钉 `{frameId: 0}` |
| `background/context-menus.js:253/259/270/286/315` | 五处 `tabs.sendMessage` 不带 frameId | A1 按 §2.8 表钉 |
| `background/ocr-recognize.js:147` | `OCR_PROGRESS` 不带 frameId | A1 记下发起 frame 并钉回去 |
| `popup/popup.js:100/519/759` | 漫画 / `sendToActiveTab` / 探测引擎 不带 frameId | A1 钉 0 |
| `options/options.js:515/545` | `SETTINGS_UPDATED` / 语言包就绪 广播 | 保持广播（每个 frame 都该知道） |
| `content/content-translation-engine.js:577` | `ctx.requestTranslation(message)`：引擎选择、内置/AI、回退 | A1：子 frame 覆写成中继 |
| `content/content-page-translation.js:25` | `translatePage()`；`:60` 从 `document.body` 收块；`:64` 紧接着读受管跳过数；`:67-75` 零块提示 | A1：手动代次 + 零块提示；A2：`:60` 改走正文范围 |
| `content/content-page-translation.js:127` | `hasPageTranslations()` 只查本文档 light DOM | A1：并上子 frame 汇报；A2：查询穿 shadow |
| `content/content-page-translation.js:161` | `togglePageTranslation()` | 不改（靠 `hasPageTranslations` 与显隐钩子自然覆盖子 frame） |
| `content/page/collect.js:51` | `collectTranslatableBlocks(root)`；`:60-62` 站点适配器排除；`:270` `processElement` 跳过链；`:281` exclude 用 `closest`；`:596` 占位符读文 | A2：穿 shadow、notranslate、范围 |
| `content/page/visibility.js:32` | `setTranslationsVisible()`；`:42/:177/:183/:186` `document.querySelectorAll` | A1：函数末尾一行显隐钩子；A2：四处改走 `queryAllDeep` |
| `content/page/batch.js:347` | `ctx.insertTranslationBlock(block, translation, {lang})` | A2：插入后钩子（shadow 样式、slot） |
| `content/content-auto-discover.js:105` | `mutationRoot()` 遇 ShadowRoot 返回 null；`:168` 塌缩成 `[document.body]`；`:189` 收块；`:413` 只观察 `document.body` | A2：观察登记过的 shadow root、收块带范围 |
| `content/content-auto-translate.js:195` | `resolve()` → `SiteRules.decide(...)`，形状 `{verdict, reason, rule, refused}`（`shared/site-rules.js:336-348`） | A1：子 frame 由 `ctx.frameDecision` 顶替 |
| `content/content-auto-translate.js:~820` | `subscribe(listener)` 广播 `snapshot()` | A1：顶层据此算指令 |
| `content/css/translation.css:62-63` | 只有 `html body .ai-translator-inline-block::before/::after` 带 `html body` 前缀 | A2：注进 shadow 时去掉该前缀 |
| `content/content-float-ball.js:474-545` | 悬浮菜单 8 项；`:616` action 分派 | A2：加「翻译整个页面」 |
| `shared/default-settings.js` | `CONTENT_DEFAULTS` | A2：加 `pageTranslateScope: 'main'` |

## 2. A1 — frames

### 2.1 manifest

`content_scripts[1]` 加三个标志：`"all_frames": true`、`"match_about_blank": true`、`"match_origin_as_fallback": true`（`<all_urls>` 满足后者对路径 `*` 的要求）。CSS 随之进入所有 frame——它们全部以 `.ai-translator-*` 为作用域，对不翻的 frame 无副作用。`content_scripts[0]`（YouTube MAIN world 拦截器）不动。

### 2.2 资格：dormant 闸

新文件 `shared/frame-eligibility.js`（纯逻辑，单测覆盖），在 `content-bootstrap.js` 之前加载。`content-bootstrap.js` 建 ctx 之前一行：

```js
if (globalThis.FrameEligibility && !globalThis.FrameEligibility.shouldActivate()) return;
```

没有 ctx，后面每个模块都在 `if (!ctx) return;` 处退出，`content.js` 的 `init?.()` 成空操作。**必须有一条单测证明 dormant 就是 dormant**：在 vm 沙箱里按 manifest 顺序跑 `content_scripts[1].js` 全部文件，桩掉 `chrome` / `document` / `window` 并记录监听器注册（`addEventListener`、`chrome.runtime.onMessage.addListener`、`chrome.storage.onChanged.addListener`、`MutationObserver`），`shouldActivate()` 为 false 时断言零注册。shared/ 里若有模块在加载时就注册监听，要么改成惰性，要么在 PR 里逐条申报。

`shouldActivate()`：

1. 顶层（`window.top === window`）→ true。
2. `document.designMode === 'on'` → false（TinyMCE 一类富文本编辑器 frame）。
3. 按 frame 的 `location`（`about:blank` / `about:srcdoc` 继承父文档，视为可进）匹配**静态拒入表**，命中 → false：
   - 广告：googlesyndication、doubleclick、googleadservices、adnxs、amazon-adsystem、taboola、outbrain、criteo、adsrvr、pubmatic、rubiconproject、openx、moatads、adform、smartadserver、media.net、2mdn、adsafeprotected、doubleverify、serving-sys、flashtalking、teads、safeframe（`*.safeframe.googlesyndication.com` 等）
   - 验证码：`google.com/recaptcha`、recaptcha.net、hcaptcha、challenges.cloudflare.com、arkoselabs / funcaptcha、geetest
   - 支付：js.stripe.com、m.stripe.network、paypal、braintree、adyen、pay.google.com、klarna、squareup
   - 登录：accounts.google.com、appleid.apple.com、login.microsoftonline.com
   - 播放器：`youtube.com/embed`、youtube-nocookie、player.vimeo.com、player.bilibili.com、`open.spotify.com/embed`、`w.soundcloud.com/player`、dailymotion embed、player.twitch.tv、wistia
4. frame 自己的 `window.name`，以及同源时 `window.frameElement` 的 id / name：命中 `google_ads_iframe`、`aswift_`，或按词边界命中 `ad|ads|advert|banner|sponsor` → false。
5. 其余 → true。**CMP / 同意框、X（Twitter）嵌入、Disqus 评论保留**（它们是用户要读的内容）。

表按「主机后缀 + 可选路径前缀」写成数据，和 `shared/site-rules-builtin.js` 同样是纯数据；单测逐条钉住每类至少一个正例、一个反例（例如 `news.example.com` 里带 `ads` 字样的正文路径不误伤）。

**动态尺寸闸**（翻译那一刻才判，不在 dormant 闸里）：子 frame 的 `innerWidth ≥ 120 && innerHeight ≥ 40` 才翻（隐藏的 iframe 量出来是 0×0）；不够就挂一个 `resize` 监听，撑开后再判。阈值写成具名常量。

### 2.3 角色与裁剪初始化

`ctx.frameRole = 'top' | 'child'`（bootstrap 建 ctx 时定）。`ctx.init` 里只属于顶层的步骤加 `ctx.frameRole === 'top'` 闸：

| 步骤（`content-bootstrap.js`） | 顶层 | 子 frame |
|---|---|---|
| loadSettings / setupSelectionListener / setupHoverTranslation / setupImageOcrHoverButton / setupInputTranslateChip | ✔ | ✔（作用于 frame 内） |
| setupMessageListener | ✔ | ✔（过滤，见 §2.4） |
| setupStorageListener | ✔ | ✔ |
| createFloatBall `:201` | ✔ | ✘ |
| setupAutoTranslate `:204` | ✔ | ✔（跟随模式，见 §2.6） |
| setupVideoCaptionTranslation `:208` | ✔ | ✘（嵌入播放器字幕 → backlog） |
| setupAutoStatus `:211` / setupPdfPrompt `:214` / setupLanguagePackPrefetch `:216` / resumeComicJobs `:220` | ✔ | ✘ |

新模块放 `content/frames/`（顶层联络与子 frame 联络，按 1k 行规则自行切分），在 `content/content-messaging.js` 之前加载。

### 2.4 协议

新文件 `background/frame-relay.js`，自己注册一个 `chrome.runtime.onMessage` 监听，**只认 `FRAME_*`**，其余一律不回（不影响 `background.js:63` 那个总分派）。`background.js` 在 `import './ocr-recognize.js'` 那一行（`:50`）之后加 `import './frame-relay.js';`。服务工作者是无状态路由：

| 消息（发送方 → SW） | SW 动作 | 回话 |
|---|---|---|
| `FRAME_HELLO {}`（子 frame 初始化、`pageshow` 恢复时） | 转 `FRAME_CHILD_HELLO {frameId, documentId}` 给 `{frameId: 0}` | 顶层当前指令，或 `null`（顶层尚未就绪） |
| `FRAME_REPORT {translated, total, error}`（子 frame 每轮结束） | 转 `FRAME_CHILD_REPORT` 给 frame 0 | — |
| `FRAME_BYE {}`（子 frame `pagehide`） | 转 `FRAME_CHILD_BYE` 给 frame 0 | — |
| `FRAME_DIRECTIVE_BROADCAST {directive}`（顶层，指令变化时） | `tabs.sendMessage(tabId, {type: 'FRAME_DIRECTIVE', directive})` 不带 frameId（所有 frame） | — |
| `FRAME_ENGINE_REQUEST {message}`（子 frame） | 转 `FRAME_ENGINE_RELAY {message}` 给 frame 0 | 顶层 `ctx.requestTranslation(message)` 的结果原样返回 |

登记表键是 `sender.documentId || sender.frameId`，存在**顶层联络模块**里。顶层收到自己广播的 `FRAME_DIRECTIVE` 直接忽略。顶层初始化完成即广播一次指令——子 frame 比顶层先起时 HELLO 拿到 `null`，靠这一次广播补上。

### 2.5 引擎中继

子 frame 覆写 `ctx.requestTranslation`，整条消息（可序列化）经 `FRAME_ENGINE_REQUEST` 交给顶层执行。**凡是读「本文档」才答得出的量，都在子 frame 里算定后写进消息**，不许让顶层拿自己的文档去答：

| 量 | 原来在哪算 | 中继时 |
|---|---|---|
| `allowDownload` | `content-translation-engine.js:335-336`（`options.allowDownload === true \|\| (options.allowDownload !== false && !!navigator.userActivation?.isActive)`） | 子 frame 按同一规则算定写进消息（结果对中继请求恒为「不下载」，见下） |
| 页面级源语言兜底 | `content/engine/languages.js:197` `resolveSourceLang()` 在没有 `sourceLang` 提示、短文本自测不可靠时退到 `getPageSourceLang()`（读 `document.body.innerText`，`:101`） | 子 frame 取自己的 `ctx.builtinTranslator.pageSourceLang()` 写进消息的新字段 `pageSourceLang`；`resolveSourceLang` 增加这个**兜底**参数（有就用它代替 `getPageSourceLang()`），`handleWithBuiltin`（`:505`）把它从消息传下去。它不是 `sourceLang` 那种硬提示——硬提示会跳过逐块自测，混合语言的子 frame 会被整片判成一种语言 |

分层保持原样：缓存层 `ctx.requestTranslationCached`（`content/content-translation-cache.js:59`，存 `chrome.storage`，各 frame 共用）在子 frame 里照常先查，只有未命中的部分走中继；顶层执行引擎选择、回退与 `refuseAutoAiSpend` 每日额度闸，对子 frame 一视同仁。中继的请求**不触发模型下载**（顶层没有用户手势），缺模型时返回的就是顶层原有的「需要下载」错误——已知限制。

### 2.6 指令与跟随

顶层联络模块订阅 `ctx.autoTranslate.subscribe(...)`，并在 `translatePage()` 开头、显隐变化时重算指令：

```
directive = {
  epoch,          // 每次变化 +1
  translate,      // 自动翻译 status ∈ {idle, running}，或 state.isTranslatingPage
  manualEpoch,    // 每次顶层 translatePage() +1
  visible,        // state.translationsVisible !== false
  scopeOverride   // state.pageScopeOverride || null（A2 的整页覆盖，见 §3.4）
}
```

子 frame：

- **自动**：`content-auto-translate.js` 的 `resolve()` 开头加一行 `if (ctx.frameDecision) return ctx.frameDecision(lang, options);`。子 frame 的 `frameDecision` 先拿**自己的主机**问一次 `SiteRules.decide({..., explicit: true})`——阶梯上 explicit 之前只剩黑名单 / 内置 never / 用户 never，所以 `refused === true` 就是「这个站点不许碰」，照原样返回；否则按指令返回 `{verdict: translate ? 'auto' : 'off', reason: translate ? 'FRAME_FOLLOW' : 'FRAME_IDLE', rule, refused: false}`（形状与 `decide()` 完全一致）。这两个 reason 只活在子 frame 里（子 frame 没有状态层，不会被画成文案），不进 `SiteRules.REASONS`。指令的 `translate` 变化时子 frame 调自动翻译重开一轮。子 frame 的自动轮次**不写 autoStats**（那张表记的是「用户访问的站点」）。
- **手动**：子 frame 记下 HELLO 时的 `manualEpoch`；之后收到更大的 `manualEpoch`，且尺寸闸通过，就跑一轮**静默手动翻译**（`auto: false`，无进度条），收块走与顶层同一个生产入口（A2 的 `ctx.collectPageBlocks()`）。晚到的 frame（HELLO 时指令已是 `translate: true`）不补手动轮，直接进跟随模式。
- **显隐**：`visible` 变 false → `ctx.setTranslationsVisible(false)`；变 true → 放出来。
- **整页覆盖**：精确镜像顶层——指令里的 `scopeOverride`（缺省即 `null`）与本 frame 的 `state.pageScopeOverride` 不同才写（设和清都写），并调 `ctx.invalidatePageScope()`（A2 提供）；同值不动。只在非空时写的初稿会让子 frame 永远停在顶层已经清掉的覆盖上。

顶层的显隐钩子：`content/page/visibility.js` 的 `setTranslationsVisible()` **函数末尾**加一行 `if (ctx.frames) ctx.frames.onVisibilityChanged(visible);`（只有顶层会据此广播；子 frame 的同名方法是空操作）。放在函数末尾是为了和 A2 在同一文件 `:42` 的改动隔开。

### 2.7 顶层汇总

- `hasPageTranslations()`（`content-page-translation.js:127`）：本文档有，或任一存活子 frame 最近一次汇报 `translated > 0`。于是 Alt+A、悬浮球、popup 的「隐藏译文」在只有 iframe 被翻过的页面上照样对。
- 零块提示（`:67-75`）：顶层一块也没收到、但有已登记且过了尺寸闸的子 frame 时，不报「已翻译 / 无可译内容」，收起进度条后返回（子 frame 各自静默翻）。
- 子 frame 汇报带 `error` → 顶层 `ctx.showTranslationError(error)`。

### 2.8 tab 消息钉 frame

| 位置 | 消息 | 钉到 |
|---|---|---|
| `background/background.js:299` | `TOGGLE_PAGE_TRANSLATION` | `{frameId: 0}` |
| `background/context-menus.js:253` | `TRANSLATE_SELECTION_TEXT` | `{frameId: info.frameId}` |
| `background/context-menus.js:259` | `TRANSLATE_PAGE` | 0 |
| `background/context-menus.js:270` | `COMIC_TRANSLATE_IMAGE` | 0（漫画只在顶层；iframe 里的图 → backlog） |
| `background/context-menus.js:286` | `OCR_TRANSLATE_IMAGE` | `info.frameId` |
| `background/context-menus.js:315` | `CLEAR_INLINE_TRANSLATION_CONTEXT` | `info.frameId` |
| `background/ocr-recognize.js:147` | `OCR_PROGRESS` | 发起识别的那个 frame（请求进来时记下 `sender.frameId`） |
| `popup/popup.js:100` | `COMIC_TRANSLATE_PAGE` | 0 |
| `popup/popup.js:519` `sendToActiveTab` | `AUTO_PAGE_STATE` / `TOGGLE_PAGE_TRANSLATION` / `SET_AUTO_PAUSED` | 0 |
| `popup/popup.js:759` | `PROBE_ENGINE` | 0 |
| `options/options.js:515/545` | `SETTINGS_UPDATED` / 语言包就绪 | 保持广播 |

纵深防御：子 frame 的消息监听对顶层专属消息（`TRANSLATE_PAGE`、`TOGGLE_PAGE_TRANSLATION`、`SET_AUTO_PAUSED`、`AUTO_PAGE_STATE`、`PROBE_ENGINE`、`COMIC_*`、以及 A2 的 `TRANSLATE_WHOLE_PAGE`）一律不回——哪天有个没钉 frame 的发送点，第一个回话的也只会是顶层。单测钉住：生产代码里每一处 `tabs.sendMessage` 要么带第三个参数，要么在「保持广播」白名单里。

### 2.9 注入成本

`scripts/measure-frame-injection.mjs`（Playwright + CDP）：同一页面挂 N 个 dormant frame 与 N 个可翻 frame，对比 manifest 开/关 `all_frames` 两份扩展副本的脚本求值耗时（`Performance.getMetrics` 的 `ScriptDuration` 或 tracing），输出每 frame 的均值。结果写进 PR。已知参照：78 个脚本整体编译约 5.6–7.6 ms（1.25 MB）。dormant frame 每个超过约 15 ms 就把「两段式注入（`chrome.scripting` 按需注入）」登记 backlog——那要新权限，本轮不做。

## 3. A2 — Shadow DOM、notranslate、正文范围

### 3.1 Shadow DOM

新文件 `content/page/shadow.js`（在 `content/page/collect.js` 之前加载）：

- **发现**：`el.shadowRoot`（open）；自定义元素（标签名含 `-`）再问 `chrome.dom.openOrClosedShadowRoot(el)`（closed）。
- **登记表**：发现过的 root 进一张表，可订阅（发现层据此追加观察）；取用时剔除 `host.isConnected === false` 的。
- **工具**：`ctx.queryAllDeep(selector)`（文档 + 全部登记 root）、`ctx.closestComposed(el, selector)`（`closest` 撞到 root 就从 `host` 接着往上）、组合树子节点（有 shadow root 的宿主：遍历 shadow 树 + `assignedSlot !== null` 的 light 子节点；`<slot>` 只在 `assignedNodes().length === 0` 时收它的后备内容——不重复、不收没渲染的节点）。
- **收块**（`collect.js`）：遍历进 shadow root；自定义元素 / 带 shadow root 的元素按容器处理；跳过链里需要穿边界的判断（exclude、代码容器、我方 UI、notranslate、范围）改走 `closestComposed`。
- **样式**：新文件 `background/page-coverage.js`，`background.js` 在 `import './icon.js';`（`:41`）之后加一行 import。它处理 `GET_SHADOW_STYLES`：读 `SHADOW_STYLE_FILES = ['content/css/translation.css']` 的文本，改写选择器前缀后返回：`html body ` 直接去掉；`html<条件> body ` 换成 `:host-context(html<条件>) `——译文样式、仅显示译文这类条件挂在文档的 `<html>` 上，shadow 树里只有 `:host-context` 看得到（`background/page-coverage.js` 的 `toShadowCss`，e2e 在真浏览器里量过条件生效）。内容脚本缓存这段文本（空文本不缓存；并发的 root 共用一次在途请求），建一张共享的 `CSSStyleSheet`（`replaceSync`），追加进 root 的 `adoptedStyleSheets`。**只有这一条路**：要不到样式、`replaceSync` 或 adopt 失败，都在接住的地方打一条带操作名和原始错误的日志，下一次插入再试；不退回 `<style>`（整合回合删去，台账 D-297）。单测守卫：manifest `content_scripts[1].css` 里，凡是（去掉注释后）有选择器命中页面翻译挂在页面节点上的类名（至少 `ai-translator-inline-block`、`ai-translator-source-hidden`、`ai-translator-hidden`、`ai-translator-inline-right`）的文件，都必须在 `SHADOW_STYLE_FILES` 里——今天只有 `translation.css`（`light-theme.css:42` 只是一行注释）；P0-C 若加显示样式文件，会被这条拦下。去前缀也要有守卫：转换后的文本里不许再出现 `html` / `body` 开头的选择器（shadow 树里没有这两个元素，这样的规则静默失效）。
- **插入后钩子**（`batch.js:349`，无条件调用 `ctx.afterInsertTranslation(block);`——整合后 shadow.js 与 batch.js 总在同一张加载清单里，软读守卫删去）：块在 shadow 树里 → 确保该 root 挂了样式（每次插入都复核，root 可能被站点重建）；块本身带 `slot` 属性、译文是它的兄弟节点 → 把 `slot` 抄给译文节点（否则译文掉进默认 slot 或根本不渲染）。**不改 `content/page/insert.js`**（P0-C 在改）。
- **发现层**（`content-auto-discover.js`）：订阅登记表，对每个新 root 追加 `domObserver.observe(root, 同样的选项)`；`mutationRoot()` 遇到目标是 ShadowRoot 时返回它的 `host`。
- **显隐与判定**：`visibility.js:42/177/183/186` 与 `hasPageTranslations()` 的 `document.querySelectorAll` 改走 `ctx.queryAllDeep`。其余查询译文节点的 `document.querySelectorAll`（换路由清理、受管译文等）逐个排查，凡是 shadow 里可能有译文的一并改——同一类问题一次改全。

### 3.2 notranslate

新文件 `content/page/notranslate.js`（或并入 scope 模块，按 1k 行规则自定）：

- 判定：从元素本身往上（穿 shadow 边界），**第一个**带 `translate` 属性或 `notranslate` 类的祖先说了算；同一元素上 `notranslate` 类或 `translate="no"` → 不译，仅 `translate="yes"` / `translate=""` → 译。走到 `<body>` 为止，`<html>` / `<body>` / `<meta>` 上的声明不认。
- 复杂度：收块是自上而下遍历，判定状态随遍历往下传（或用 WeakMap 记忆），**不许每个元素各自往上爬一遍**。
- 块级不译 → 跳过这一块及其子树（子树里 `translate="yes"` 的重开）。
- 行内不译（如段落里的 `<span class="notranslate">产品名</span>`）→ 在 `getTextWithMathPlaceholders`（`collect.js:596`）里按元素占位符 `{{n}}` 处理，插入时由现有的占位符回填原样克隆回去——译文里保留原词原样。

### 3.3 正文范围

新文件 `content/page/scope.js`：

- 设置 `pageTranslateScope: 'main' | 'page'`，默认 `'main'`，进 `shared/default-settings.js` 的 `CONTENT_DEFAULTS`（服务工作者、设置页的默认表若也列了它，值必须一致——`test/unit/default-settings-agree.test.mjs`）。
- 文档级覆盖 `state.pageScopeOverride = 'page'`（整页入口写它，文档存续期内有效）；`ctx.invalidatePageScope()` 清缓存。
- `ctx.resolvePageScope()` → `{mode, roots, skip, share}`，按顺序：
  1. 有效模式（`pageScopeMode()`，悬浮菜单每次打开都问，只判模式不找根）依次看：① 本页临时覆盖 `state.pageScopeOverride === 'page'`；② P1-B 的用户规则 `include` 挂点（本轮是空步，只在 `content/page/scope.js` 的判定顺序注释里占位：至少命中一个渲染出来的元素才算，命中零个不缓存，命中时模式记为 `'include'`）；③ 设置为 `'page'` 或内置站点规则命中（`SiteRules.matchBuiltin(location.hostname, location.pathname)`）；④ 默认 `'main'`。①或③成立 → `mode: 'page'`，行为与今天完全相同。覆盖排在最前：它是用户对这一页刚说的话，任何规则都不该盖过它。
  2. 唯一的 `main` / `[role=main]` 且其文字量 ≥ body 的 `MAIN_TEXT_SHARE`（≈0.3）→ 它就是根。
  3. 否则 body。
  4. `h1` 不受 header/footer 那条跳过规则约束（仍受 nav/aside/菜单约束），根之外的 `h1` 也一并收——标题常在 `main` 外、在页面级 `<header>` 里；站点把 logo 写成 `h1` 时多译一个站名，代价远小于漏译标题。
- **不做启发式正文抽取**（多个 `article` 各自为根、段落密度胜出者为根——初稿有这两步，2026-09-24 删去，台账 D-292）：它们在没有语义标记的页面上会**静默丢掉正文**（导语、评论区、第二栏），用户看到半页没翻却不知道为什么；少跳几块导航的代价只是多翻几个词。所以 `'main'` 只做减法：减掉页面**自己标明**的非正文（下面的跳过规则），外加信任作者声明的 `main`。**不变量（必须有断言）**：页面上既没有 `main` / `[role=main]`、也没有任何跳过规则里的元素或角色时，`'main'` 与 `'page'` 收到的块完全相同。
- 跳过（仅 `'main'` 模式）：`nav`、`aside`、`menu`、`[role=navigation]`、`[role=complementary]`、`[role=menu]`、`[role=menubar]` 任何位置都跳；`header`、`footer`、`[role=banner]`、`[role=contentinfo]` **只在不处于** `article` / `main` / `[role=main]` / `section` 之内时跳（文章自己的页眉页脚是正文）。
- 阈值只有 `MAIN_TEXT_SHARE` 一个，具名常量，在夹具上调定并在 PR 里申报。
- 缓存键 = URL + 设置值 + 覆盖值（换路由、改设置、点整页入口都换键，不另挂监听，本模块不注册任何观察者）；根脱离文档时重算。**退回 body 的结果也缓存**，带 `fallback` 标记：一轮收集里问多少次、一批发现里有多少个脏根，body 的字数都只数一次。每一轮收集开始时（发现层的 flush、手动整页翻译、子 frame 的手动轮各调一次 `ctx.beginScopeRound()`）只作废 `fallback` 的那份缓存——SPA 首屏晚长出正文的 `<main>` 下一轮就能认出；认出来的 `<main>` 跨轮有效。`ctx.invalidatePageScope()` 整个丢掉（整页入口、子 frame 换覆盖值）。代价：页面停在退回 body 时，每轮手动翻译都要重数一次 body（一次 `textContent`）。
- 生产入口统一成 `ctx.collectPageBlocks(root = document.body)` = `ctx.collectTranslatableBlocks(root, { scope: ctx.resolvePageScope() })`。`content-page-translation.js:60`、`content-auto-discover.js:189`、A1 的子 frame 手动轮都走它。`collectTranslatableBlocks(root)` 不带 scope 时行为**不变**（e2e 直接调它 15 处）。
- 带 scope 收块：脏根在某个范围根之内 → 照常收并套跳过规则；脏根包含范围根 → 只收范围根之内；脏根与范围根无交集 → 只收孤立 `h1`。

### 3.4 「翻译整个页面」入口

- manifest `commands.translate-whole-page`：`suggested_key` `Alt+W`，`description` `__MSG_cmdTranslateWholePage__`。`background/page-coverage.js` 自己加一个 `chrome.commands.onCommand` 监听，只认这条命令，发 `{type: 'TRANSLATE_WHOLE_PAGE'}` 到 `{frameId: 0}`。P0 若也新增命令且撞了 Alt+W，谁后合谁改键（截至 2026-09-24 P0 各 worktree 均未动 `commands`）。
- 悬浮球菜单在 `translate-page` 之后加 `data-action="translate-whole-page"`（`t('floatMenuTranslateWholePage')`），**只在当前有效范围是 `'main'` 时出现**（设置已是整页时，原来那一项就是整页，不出重复项）。
- `ctx.translateWholePage()`（放 scope 模块）：写 `state.pageScopeOverride = 'page'`、清范围缓存；若这一页在整页范围下已翻完且译文可见 → 与 Alt+A 同样藏起来；否则 `ctx.translatePage()`（已翻的块收集器本来就跳过，只补范围外的那部分）。
- `content-messaging.js` 加 `case 'TRANSLATE_WHOLE_PAGE'`。

### 3.5 设置页

新模块 `options/options-page-scope.js`（`options.js` 已 900 行，只许加接线的几行）：一个二选一控件（「只翻译正文（推荐）」/「翻译整个页面」）+ 一行说明，写 `pageTranslateScope`，走现有 `collectSettings` 那次整份写入的通道。i18n 键见 §6。

## 4. 旅程规格（e2e，一条旅程至少一个 spec）

| # | 旅程 | 步骤 → 用户可观察结果 |
|---|---|---|
| J-1 | 同源 iframe | 打开含同源 iframe 的页面 → 点悬浮球「翻译」→ 顶层与 iframe 段落都出现译文 → Alt+A（经 SW 发 TOGGLE）→ 两边译文都藏起、原文可见 → 再按 → 两边都回来 |
| J-2 | 跨源 iframe + 广告 frame | 页面含一个跨源内容 iframe 与一个假 doubleclick 广告 frame（`context.route`）→ 翻译 → 内容 iframe 有译文，广告 frame 里同为外文的段落没有任何 `ai-translator` 节点 |
| J-3 | 自动翻译跟随 | 站点设为「总是」→ 打开页面 → 顶层与 iframe 自动出现译文 → 之后动态插入一个 iframe → 它也被翻 |
| J-4 | popup 状态只认顶层 | 含跨源 iframe 的页面上打开 popup（或经 SW 发 `AUTO_PAGE_STATE`）→ 回话里的 host 是顶层 host |
| J-5 | Shadow DOM | 页面含 open root、closed root（自定义元素）、带命名 slot 的组件 → 翻译 → 三处都有译文；shadow 里译文的计算样式来自 translation.css（取一个该文件定义的属性断言）；slot 里的译文可见（bounding box 非零，且在宿主盒内） |
| J-6 | notranslate | `<html translate="no">` 的页面照样翻；`<p translate="no">`、`.notranslate` 容器不翻；`translate="no"` 里的 `translate="yes"` 段落翻；段落里行内 `<span class="notranslate">BrandX</span>` 在译文里原样出现 |
| J-7 | 新闻页默认正文 | 夹具：站点 header+nav、main>article（含文章自己的 header/footer）、aside、站点 footer → 翻译 → 文章段落与文章页眉有译文，nav/aside/站点页眉页脚没有 → 打开悬浮菜单，「翻译整个页面」项可见且几何在菜单盒内、菜单在视口内 → 点它 → nav/aside 也有译文；同一夹具放进 iframe 再走一次：点顶层悬浮菜单的「翻译整个页面」→ 覆盖经指令带进子 frame，iframe 里的 nav/aside 也有译文；同一夹具另走一次：经 SW 发 `TRANSLATE_WHOLE_PAGE`（等价 Alt+W）→ 同样结果；再用一份去掉 `main` 的同构夹具（body 为根）→ 译/不译的分布与有 `main` 时相同，页面级 `<header>` 里的 `h1` 有译文 |
| J-8 | 设置改整页 | 设置页把范围改成「翻译整个页面」→ 重载 J-7 夹具 → 翻译 → nav 有译文；悬浮菜单里不出现「翻译整个页面」 |

现有 e2e 里期望导航/侧栏被翻的（如 horizontal-nav、sidebar 一类）改为显式钉 `pageTranslateScope: 'page'`，每一处在 PR 里列出。

### 4.1 承诺清单 → 断言

| 文案承诺 | 断言 |
|---|---|
| 「只翻译正文（推荐）」 | J-7：nav/aside/站点页眉页脚零译文节点；且不丢正文——无 `main`、无跳过元素的页面上 `'main'` 与 `'page'` 收块相同（§3.3 不变量） |
| 「翻译整个页面」 | J-7：点击后 nav/aside 有译文 |
| 隐私政策：「翻译页面时包含嵌入框架里的文字；广告、支付、验证码、登录框架不读取」 | J-1/J-2：内容 frame 有译文、广告 frame 零节点；单测：支付/验证码/登录样例全部 `shouldActivate() === false` |

## 5. 已知限制（写进 PR 与 backlog）

- 子 frame 里的手势不能触发模型下载（请求在顶层执行，顶层无手势）。
- 嵌入播放器（YouTube embed 等）的字幕翻译不在本轮（播放器 frame 静态拒入）。
- iframe 里的漫画图片翻译不在本轮（漫画只在顶层）。
- 受管容器（`::after` 渲染）在 shadow 树里不支持，那里走普通插入。
- 顶层零块、子 frame 也零块时，用户看不到任何提示（顶层把提示让给了子 frame）。
- 顶层没有我们的内容脚本（例如顶层是扩展页、商店页）时，子 frame 不翻，其中的划词翻译因中继无人应答而报错。
- 「翻译整个页面」的本页覆盖（`state.pageScopeOverride`）没有清除入口：设了就一直是整页，直到重新加载页面才回到默认范围。子 frame 精确跟随顶层（设、清都跟），所以将来加了清除入口，子 frame 不用再改。

## 6. i18n

| 键 | 位置 | 用途 |
|---|---|---|
| `cmdTranslateWholePage` | `_locales/*/messages.json`（10 种） | 命令说明（chrome://extensions/shortcuts） |
| `floatMenuTranslateWholePage` | `i18n/lang/*`（10 种） | 悬浮菜单项 |
| `pageTranslateScopeLabel` / `pageTranslateScopeMain` / `pageTranslateScopePage` / `pageTranslateScopeHint` | `i18n/lang/*`（10 种） | 设置页 |

A1 预期不新增用户可见文案；万不得已要加，追加在各语言文件末尾并在交付时申报。

## 7. 文件归属与切批

| 文件 | A1 | A2 |
|---|---|---|
| `manifest.json` | `content_scripts[1]` 三个标志；`shared/frame-eligibility.js`、`content/frames/*` 入表 | `content/page/{shadow,notranslate,scope}.js` 入表（`site-adapter.js` 之后、`collect.js` 之前）；`commands.translate-whole-page` |
| `background/background.js` | `:50` 之后 import `frame-relay.js`；`:299` 钉 frameId | `:41` 之后 import `page-coverage.js` |
| `background/context-menus.js`、`background/ocr-recognize.js`、`popup/popup.js` | 钉 frameId | — |
| `content/content-bootstrap.js` | dormant 闸、`frameRole`、init 闸 | — |
| `content/content-messaging.js` | 子 frame 过滤 | `TRANSLATE_WHOLE_PAGE` 分支 |
| `content/content-auto-translate.js` | `resolve()` 开头一行 `frameDecision`；子 frame 不写 `AutoStats.add({pages})`（`:627`） | — |
| `content/engine/languages.js`、`content/content-translation-engine.js` | `pageSourceLang` 兜底参数（§2.5，几行） | — |
| `content/content-page-translation.js` | 手动代次、零块提示、`hasPageTranslations` 并上子 frame（函数末尾） | `:60` 改 `collectPageBlocks()`；`hasPageTranslations` 的查询改 `queryAllDeep` |
| `content/page/visibility.js` | `setTranslationsVisible()` 末尾一行钩子 | `:42/:177/:183/:186` 改 `queryAllDeep` |
| `content/page/collect.js`、`content/page/batch.js`、`content/content-auto-discover.js`、`content/content-float-ball.js` | — | ✔ |
| `shared/default-settings.js`、`options/*`、`i18n/lang/*`、`_locales/*` | — | ✔ |
| 新文件 | `shared/frame-eligibility.js`、`content/frames/*`、`background/frame-relay.js`、`scripts/measure-frame-injection.mjs` | `content/page/{shadow,notranslate,scope}.js`、`background/page-coverage.js`、`options/options-page-scope.js` |
| 加载清单守卫 | 按新增文件同步 `test/unit` 里所有 load-list 守卫与 e2e `PAGE_TRANSLATION_MODULES` | 同左 |

两批的共同文件只在上表列出的**不同 hunk**；整合时 A1 先合、A2 后合，冲突由主控消解并记台账。A1 在 A2 合入前用 `ctx.collectPageBlocks ? ctx.collectPageBlocks() : ctx.collectTranslatableBlocks(document.body)`，整合时收成直接调用。两批之间的契约只有这几个名字：`ctx.collectPageBlocks`、`ctx.invalidatePageScope`、`state.pageScopeOverride`、`ctx.frames.onVisibilityChanged`。

不碰：`content/page/insert.js`（P0-C）、`content/content-selection.js` / `content/content-popup.js`（P0-D）、目标语言与语言列表（P0）、`pdf/`（P0）、`shared/api-compat.js`（P0-A）。

## 8. 门禁

```bash
npm run test:unit > <log> 2>&1; echo "GATE unit exit=$?"
npm run test:e2e > <log> 2>&1; echo "GATE e2e exit=$?"
```

两门都是 0 才算绿。不接 `| tail`（退出码会变成 tail 的）。

## 9. Backlog（本轮登记，不做）

- 嵌入播放器字幕翻译。
- dormant 成本若超阈值：`chrome.scripting` 两段式注入（需新权限）。
- 中继请求触发模型下载（需要把顶层手势或一次显式授权带过去）。
- iframe 内漫画图片翻译。
