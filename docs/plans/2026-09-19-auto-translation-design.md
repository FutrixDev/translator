# 自动翻译（Auto Translation）现状分析与对齐方案

**目标**：把扩展从「用户点一下、翻一次」变成「打开页面就已经翻好，滚动、换路由、换视频都继续跟着翻」，
对齐沉浸式翻译在页面自动翻译、YouTube 双语字幕自动开启、arXiv 论文自动翻译上的行为。

本文只做分析与方案，不含实现。结论在 §0，代码级盘点在 §1，方案在 §3–§6，路线图在 §8。

> 2026-09-19 补充：一份第三方评审对同一课题做了独立分析，其中三条为本文所缺 ——
> popup 对免 Key 默认用户的假报错、UI 语言与目标语言耦合（两处均为现存 P0 缺陷），
> 以及虚拟列表回收 DOM 节点会打穿本文赖以成立的 `.ai-translator-translated` 幂等假设。
> 逐条核验与合并后的路线见 [核验与综合](./2026-09-19-parity-review-synthesis.md)。

---

## 0. 结论速览

1. **扩展目前没有任何形式的自动翻译。** 全仓 grep `autoTranslate|alwaysTranslate|autoMode` 零命中；
   整页翻译只有三个入口，全部是用户手势（悬浮球 / popup / 右键菜单）。
2. **整页翻译是一次性的。** `translatePage()` 收集一次 DOM 就结束，全仓没有一个针对正文的
   `MutationObserver`（唯一一个在漫画换页里）。X / Reddit 这类无限滚动的信息流，
   只会翻点击那一刻已经在 DOM 里的内容，往下滚全是原文。
3. **好消息：幂等已经具备。** 译完的源元素会被打上 `.ai-translator-translated`，
   收集阶段又会跳过带这个类和它子树里的元素（`content-page-translation.js:866`、`:1722`）。
   这意味着**增量翻译不需要重写引擎**，反复调用同一个 `translatePage()` 天然只处理新节点 ——
   P0 的主要工作是"什么时候调"和"调的时候别闪进度条"，不是"怎么翻"。
4. **YouTube 自动字幕撞到一条现行铁律**：CLAUDE.md 明文写着「我们只翻译观众已经打开的字幕，
   我们从不替他打开字幕」，`pickSubtitleTrack()`（`shared/caption-core.js:309`）只认
   `showing`/`hidden` 的轨。要做「自动插入并翻译」必须显式推翻这条规则，并落成一个默认关闭的开关。
5. **arXiv 分三种形态**：`/abs/`、`/html/`（LaTeXML）走整页自动翻译即可（代码里已有大量
   LaTeXML 适配）；`/pdf/` 走的是**账号付费**的服务端 PDF 任务，**绝不能自动触发** —— 自动扣配额是事故。
6. **最大的风险不是技术，是钱。** 自动翻译 = 打开一个页面就自动发请求。默认自动模式必须绑定
   builtin（Chrome 内置 Translator，本地、免费、无额度）；AI 引擎的自动模式要显式二次确认 +
   每日字符预算 + 每站开关。

---

## 1. 现状盘点（代码级）

### 1.1 触发链路：三个入口，全是手动

| 入口 | 位置 | 动作 |
| --- | --- | --- |
| 悬浮球菜单「翻译整页」 | `content/content-float-ball.js:395` | 直接调 `ctx.translatePage()` |
| popup「翻译此页」 | `popup/popup.html:19` | 向 tab 发 `TRANSLATE_PAGE` |
| 右键菜单「翻译此页」 | `background/background.js:703` | 向 tab 发 `TRANSLATE_PAGE` |

`TRANSLATE_PAGE` 在 `content/content-messaging.js` 里落到 `ctx.translatePage()`。
**没有第四个入口**：没有 `chrome.commands`（manifest 里没有 `commands` 段，所以没有 Alt+A 这类快捷键），
没有按站点/按语言的自动触发，没有安装后的「首次访问外文站」引导。

### 1.2 整页翻译是一次性的

`translatePage()`（`content/content-page-translation.js:74`）的流程：

```
collectTranslatableBlocks(document.body)   :637   一次性遍历
  → filterBlocksByLanguage()               :1477  逐块 chrome.i18n.detectLanguage
  → splitBlocksByViewport()                :465   首屏 ±1.2 屏优先
  → createSmartBatches() → 并发 12 翻译
  → insertTranslationBlock()               :1717  插入并给源元素打标记
```

跑完就结束。**没有** DOM 变化监听、**没有** 滚动/视口监听、**没有** SPA 路由监听。
全仓唯一的 `MutationObserver` 在 `content/content-comic-translation.js:1031`，
是漫画阅读器换页用的；唯一的路由感知是字幕侧的 `yt-navigate-finish`
（`content/content-caption-providers.js:76`）。

后果，按站点：

| 站点 | 现在的实际表现 |
| --- | --- |
| X / Twitter | 只翻点击那一刻的几条推文；往下滚全是原文；点进某条推文详情（SPA 路由）不会重翻 |
| Reddit | 同上；折叠的评论展开后是原文 |
| Hacker News | 表现最好（整页静态渲染，代码里已专门适配 table 布局） |
| YouTube 评论区 | 需要滚动加载，等于没翻 |
| Gmail / Slack / Discord | 新到的消息永远是原文 |

### 1.3 已经具备的底子（不要重写）

- **幂等标记**：源元素译完打 `.ai-translator-translated`（`:1726`），收集阶段跳过它及其子树（`:866`）。
  → 增量翻译可以直接复用 `translatePage()`。
- **首屏优先**：`splitBlocksByViewport()` 已经把首屏 ±1.2 屏的块排到前面。
  → 视口内优先翻译的一半逻辑已经在了，缺的是「视口外的先不翻」。
- **语言过滤**：`filterBlocksByLanguage()` + `isTargetLanguageText()`（置信度 ≥85%）
  会把已经是目标语言的块剔掉。→ 页面级语言判定可以复用同一套探测。
- **正文识别的积累很厚**：代码块容器按 class token 精确匹配、LaTeXML 清单、数学占位符、
  受管编辑器（Lexical/ProseMirror）的 `::after` 兜底、`fit-guard`/`clip-guard`。
  这些是做自动翻译的前提，已经付过学费了。
- **字幕的 provider 模式**：`canActivate / attach / getOverlayHost / setNativeCaptionsHidden`
  四问（`content/content-caption-providers.js`），加站点 = 加 provider。

### 1.4 没有的东西

| 能力 | 现状 |
| --- | --- |
| 站点规则（always / never / ask） | 无。没有任何 hostname 级配置，`siteRules` 这个 key 不存在 |
| 站点选择器规则（selectors / excludeSelectors） | 无。正文识别 100% 靠通用标签启发式 |
| 页面级源语言判定 | 无。只有逐块判定 |
| 「自动翻译某些语言 / 永不翻译某些语言」 | 无 |
| 增量翻译（MutationObserver） | 无 |
| SPA 路由感知（正文侧） | 无 |
| 翻译结果缓存 | **无**。同一段文字翻十次就发十次请求 |
| 键盘快捷键 | 无（manifest 无 `commands`） |
| iframe 内翻译 | 无（`all_frames` 未开） |
| Shadow DOM 遍历 | 无（`processElement` 只走 `element.children`） |
| 自动开启字幕 | 无，且被现行设计明文禁止 |
| 字幕文件（srt/vtt/ass）翻译 | 无 |
| 每日预算 / 自动模式的成本闸门 | 无 |

---

## 2. 对手的模型（沉浸式翻译，2026-09 官方文档核对）

| 能力 | 他们的做法 | 我们 |
| --- | --- | --- |
| 站点规则 | `rules[]`：`matches` / `selectors` / `excludeSelectors` / `stayOriginalSelectors` / `atomicBlockSelectors` / `injectedCss` / `translationStartMode` / `urlChangeDelay` / `observeUrlChange`，支持 `.add`/`.remove` 增量继承与 `id` 复用内置规则 | 无 |
| 自动触发 | 「总是翻译此网站 / 永不翻译」+「总是翻译某语言 / 永不翻译某语言」 | 无 |
| 快捷键 | `Alt+A` 翻译/切回原文，`Alt+W` 翻译整页（绕过智能正文区） | 无 |
| 动态内容 | `observeUrlChange` + 增量更新（文档里有 `isRealtimeIncrementalUpdate` 字段），信息流/聊天场景可用 | 无 |
| 双语字幕 | 60+ 视频站，含 Netflix / Prime / Disney+ / Bilibili / Coursera / Udemy / edX / TED / Vimeo / Khan / LinkedIn Learning…；面板里一个「自动开启双语字幕」开关；衍生到 Zoom / Google Meet / Teams 的会议字幕 | 2 个 provider（YouTube timedtext + 通用 TextTrack），无自动开启 |
| 文件类 | PDF、EPUB/Mobi、字幕文件、图片、漫画（45+ 站） | PDF（账号付费）、图片 OCR、漫画（账号付费）；无 EPUB、无字幕文件 |
| 缓存 | 有，且每 30 天自动清理 | 无 |
| 质量闸门 | 响应/请求 token 比例异常则判为无效译文，换下一个服务 | 有同类守卫（分隔符数量不匹配 → 退回逐块），但无比例校验 |

**判断**：他们的护城河是「规则库 + 站点适配的长尾」，不是翻译质量。
我们的通用正文识别其实相当强（维基/arXiv/HN 的坑都踩过了），
缺的是**触发层**和**动态内容层** —— 这两层是通用的，做一次全站受益，不是 60 个站抄 60 遍。

---

## 3. 差距一：页面自动翻译（X / Reddit / …）

做成需要四件套，缺一不可：

### 3.1 站点规则 + 触发决策（新模块 `shared/site-rules.js`）

```js
// chrome.storage.sync
siteRules: { "x.com": "always", "news.ycombinator.com": "never" }   // always | never | ask
autoTranslateSourceLangs: ["en", "ja"]    // 空数组 = 除目标语言外全部
neverTranslateLangs: ["zh-CN"]
autoTranslateEngine: "builtin"            // 自动模式专用引擎，默认内置
```

决策函数是纯函数（可单测，符合 `shared/` 的定位）：

```
decideAutoTranslate({ hostname, path, pageLang, targetLang, rules, settings })
  → 'translate' | 'skip' | 'offer'
```

`offer` 是第三态：不自动翻，但在悬浮球上提示「这页是英文，翻译？」，点一下并记住该站 ——
这是把 `ask` 变成 `always` 的唯一自然路径，比让用户去设置页找列表好得多。

### 3.2 页面级语言判定

取首屏最靠前的 N（建议 5–8）个候选块的正文拼接 → `chrome.i18n.detectLanguage` →
置信度 ≥85% 才采信（与 `isTargetLanguageText()` 同一条标准，别写第二套阈值）。
判定不了就走 `offer`，不要赌。

时机：`document_end` 之后 + `requestAnimationFrame` + 200–400ms debounce。
太早会撞上 SSR 后的 hydration（X / Reddit 首屏会被整片替换，翻了也白翻）。

### 3.3 增量翻译（新模块 `content/content-auto-translate.js`）

核心是一个调度器，不是新引擎：

```
MutationObserver(document.body, {childList:true, subtree:true})
  → 收集新增子树 → debounce 400ms
  → 过 IntersectionObserver：只把进入「视口 ±1 屏」的新块入队
  → 队列非空且当前没在翻 → 调 translatePage()（静默模式）
```

三个必须处理的细节：

1. **`state.isTranslatingPage` 会吞掉并发调用**（`:79`），现在的行为是闪一下「正在翻译」提示。
   自动模式下必须改成排队：翻完一轮回来看队列还有没有新块。
2. **进度条不能闪**。`showPageTranslationProgress()` 每次都弹一条。自动模式要一个 `quiet` 参数，
   或者一个常驻的、极轻的状态点（挂在悬浮球上）。
3. **自己插的译文会触发 MutationObserver**。必须在插入期间挂起观察器，或按
   `.ai-translator-*` 前缀过滤 records —— 否则死循环。

### 3.4 SPA 路由感知（抽到 `shared/spa-navigation.js`）

全仓**没有**任何 history API 监听：`content-comic-translation.js:1004` 只是一句注释，
说的是「漫画站自己 patch 了 pushState 来改写 URL」，我们的应对是监听 `<img>` 的 `src` 变化。
所以路由感知是**全新代码**，落在 `shared/spa-navigation.js`；漫画模块可否改用它，留到它下次动的时候再看。

订阅 `pushState` / `replaceState` / `popstate`，路由变了 → 清状态 → 重新走 §3.2 判定。
（`urlChangeDelay` 这种站点级延迟参数，等真遇到问题再加，别先建模。）

### 3.5 X 和 Reddit 的具体障碍

**X（x.com）**：推文正文是 `div[data-testid="tweetText"]`，内部是一串 `<span>`（emoji、话题标签、
链接各占一个 span）。当前 `collectTranslatableBlocks` 把 `SPAN` 列为 inlineTags 单独翻译
（`:947`），而 `DIV` 是容器会递归下探 —— **一条推文很可能被拆成 5–8 个碎片分别送翻**，
译文质量必然崩。这不是自动翻译带来的问题，是现在手动翻 X 就已经存在的问题，只是没人天天翻 X 所以没暴露。

→ 规则里需要 `atomicBlockSelectors: ['[data-testid="tweetText"]']`：命中的元素整体成块，禁止下探。
这是站点规则里**第一个必须有的字段**，比 `selectors` 还关键。

**Reddit（sh.reddit.com）**：新版是 `<shreddit-post>` / `<shreddit-comment>` 等 Web Components。
需要实测正文在 light DOM 还是 shadow root：
- 在 light DOM（`[slot="text-body"]`）→ 加选择器规则即可；
- 在 shadow root → 必须先给 `processElement` 加 shadow 遍历能力（`el.shadowRoot` 递归），
  这是一个**通用能力**，不止 Reddit 受益。

**先实测再写规则**。这两条我只从代码推断，没有真机验证。

---

## 4. 差距二：YouTube 自动插入 + 自动翻译字幕

### 4.1 现行设计是明确拒绝这件事的

CLAUDE.md「Video Subtitle Translation」一节：

> **We translate the subtitles the viewer already has on; we never turn subtitles on.**

实现上有两道锁：
- `YouTubeProvider.isCaptionsEnabled()`（`content-caption-providers.js:100`）读 `.ytp-subtitles-button`
  的 `aria-pressed`，false 就整条链路静默（`content-video-captions.js:509`）；
- `pickSubtitleTrack()`（`caption-core.js:309`）只在 `showing`/`hidden` 的轨里挑，
  `disabled` 的一律返回 null。

**要做用户要的功能，就得推翻这条规则。** 这是产品决策，不是 bug，所以：
改 CLAUDE.md 那一段（写清楚新规则和为什么变），加一个默认关闭的开关，
而不是偷偷在代码里放行。

### 4.2 方案

新设置 `autoEnableCaptions`（默认 `false`），开启后：

| 场景 | 做法 |
| --- | --- |
| YouTube，视频有字幕轨但 CC 没开 | provider 新增 `enableNativeCaptions()`：`aria-pressed === 'false'` 时点一下 `.ytp-subtitles-button`。YouTube 的自动生成字幕（ASR）同样走 timedtext，CC 一开就能拿到 → 覆盖绝大多数视频 |
| YouTube，视频根本没有任何字幕轨 | 超出范围，需要自己做 ASR（已在 backlog `B-F17-2`）→ 不在本轮 |
| 通用 `<track>` 站点（Coursera / Udemy / edX / TED / Vimeo…） | `TextTrackProvider` 增加：`autoEnableCaptions` 开时，允许从 `disabled` 轨里挑一条设为 `hidden`。挑选优先级：与视频声道语言一致 > `default` 属性 > 列表第一条。**detach 时必须原样还原**（现有的 `restoreMode` 契约不能破） |

**边界要写进代码注释**：自动打开的字幕，用户手动关掉之后，本次会话不再自动打开
（现有代码已有「观众关掉的轨不还原」的先例，同一条精神）。

### 4.3 顺带的收获

`enableYoutubeCaptionTranslation` 现在**默认 false**（`content-bootstrap.js` 的 defaults）。
用户要的「打开视频就有双语字幕」，第一步其实是把这个开关在引导里推到用户面前 ——
一个从没被打开过的开关，做得再好也等于不存在。

---

## 5. 差距三：arXiv 自动翻译

arXiv 有三种形态，处理方式完全不同：

| URL 形态 | 内容 | 方案 |
| --- | --- | --- |
| `arxiv.org/abs/<id>` | 摘要页，标准 HTML | 内置站点规则 `always`，走 §3 自动整页翻译。零新代码 |
| `arxiv.org/html/<id>` / `ar5iv.labs.arxiv.org` | LaTeXML 全文 | 同上。代码里已经有成片的 LaTeXML 适配（`ltx_listing` 系列跳过、行间公式 `ltx_equation` 去重），质量有保障 |
| `arxiv.org/pdf/<id>` | PDF | **绝不自动触发**。这条路走的是账号付费的服务端任务（`background/background.js:813` 的 `isLikelyPdfUrl` 已专门认出这个无扩展名路径），自动触发 = 自动扣用户的免费页额度。正确做法：识别到 arXiv PDF 时，在页面上给一条**轻量提示条**「翻译这篇论文（消耗 N 页额度）」，点了才跑 |

顺带：`arxiv.org/list/*`、Hugging Face Papers 这类**列表页**已经有 e2e 覆盖
（`test/e2e/page-translation-paper-listing.spec.js`），加进内置规则即可。

---

## 6. 还有哪些地方可以启用自动化翻译（全景）

按「做成的边际成本」分四类。**A 类做完，B/C/D 才有意义** —— A 是地基。

### A. 页面类（做完 §3 的四件套就全部受益，只差一条内置规则）

| 站点/场景 | 需要的规则字段 | 备注 |
| --- | --- | --- |
| X / Twitter | `atomicBlockSelectors`, `excludeSelectors` | 必须做原子块，否则译文碎片化 |
| Reddit | `selectors`（或 shadow DOM 支持） | 先实测 |
| Hacker News / Lobsters | 无（通用启发式已够） | 直接 `always` 即可 |
| Bluesky / Mastodon / Threads | `atomicBlockSelectors` | 与 X 同形 |
| GitHub（issue / PR / discussion / README） | `stayOriginalSelectors`（代码块、diff、文件名） | 代码检测已有，但 diff 视图要显式排除 |
| Stack Overflow / 各类 Q&A | 同上 | |
| Medium / Substack / 个人博客 | 无 | 通用启发式的主场 |
| Wikipedia | 无（已踩过 `language-` 误判的坑） | |
| Discord / Slack / Telegram Web / WhatsApp Web | 增量翻译 + 受管编辑器兜底 | **实时消息是增量翻译最自然的场景**，新消息流入 = MutationObserver 的正样本 |
| Gmail / Outlook Web | `selectors` 锁邮件正文 | 注意别翻收件箱列表 |
| LinkedIn / 招聘站 | `atomicBlockSelectors` | |
| arXiv / bioRxiv / Nature / Science / Google Scholar | 无 | 见 §5 |
| Amazon / eBay / Steam 评论区 | `selectors` | 评论是典型「只想翻这一块」 |
| YouTube 评论区 | 增量翻译 | 与字幕无关，是页面翻译 |

### B. 视频/音频类（每个站一个 provider，成本各不相同）

| 站点 | 类型 | 成本 |
| --- | --- | --- |
| Coursera / Udemy / edX / TED / Khan / Vimeo | 标准 `<track>` | **接近零** —— `TextTrackProvider` 已经能接，只差 §4 的自动开启 |
| Netflix / Prime Video / Disney+ / HBO Max | 播放器自管字幕，不落 TextTrack | 高：每站一个 MAIN-world 网络观察 provider（且受 DRM/条款约束，需评估合规） |
| Bilibili | 站内字幕 JSON API | 中 |
| **Zoom / Google Meet / Microsoft Teams 实时字幕** | 字幕是 DOM 文本流，不是 track | 中，但**这是 provider 模式的第三种形态**（DOM provider），做一个模板出来，所有「字幕画在 DOM 里」的站点通吃。对手把这条单独拎出来宣传，说明需求真实 |
| 播客（Spotify / Apple Podcasts transcript） | DOM 文本 | 与上同形 |

### C. 文件类（当前完全空白或半空）

| 形态 | 现状 | 建议 |
| --- | --- | --- |
| 字幕文件 srt / vtt / ass | 无 | **性价比最高的空白**：`caption-core.js` 已经会解析 VTT/json3/srv3，翻译链路现成，缺的只是一个上传页 + 导出双语文件。几乎全是复用 |
| EPUB / Mobi | 扩展侧无（saas 侧有阅读台） | 与 saas 打通，而不是在扩展里重做 |
| 本地 txt / md | 无 | 低优先 |
| 本地 PDF | 有（右键 → 翻译本地 PDF） | 已覆盖 |

### D. 已有功能的「自动化」升级

| 功能 | 现状 | 可自动化的部分 | 慎重 |
| --- | --- | --- | --- |
| 图片 OCR | 右键 / hover 按钮触发 | 「自动识别页面内图片」 | ⚠️ 成本高（本地 Tesseract 也吃 CPU），建议保持手动，最多做「自动显示按钮」（已有） |
| 漫画 | 右键 / 悬浮球 | 有站点列表后可自动进入漫画模式 | ⚠️ 账号付费，自动 = 自动扣额度，**只能自动显示入口，不能自动翻** |
| 输入框翻译 | 手动唤起 | 自动检测输入语言，提示「译成英文？」 | 可做，低风险 |
| 划词 / 悬停 | 已是"准自动"（按住热键） | — | — |

---

## 7. 成本与风险闸门（这一节不做，自动翻译就不能上线）

1. **默认引擎**：自动模式**默认且只默认** `builtin`（Chrome 内置 Translator，本地推理、免费、离线）。
   用户要用 AI 引擎跑自动翻译，必须在设置里单独打开并看到一句明确的成本说明。
2. **翻译缓存**（P0 必做）：`hash(text + targetLang + engine) → translation`，
   内存 LRU + `chrome.storage.local` 持久化，30 天过期清理。
   信息流场景重复率极高（转推引用、重复回帖、翻页回来），没有缓存，AI 引擎的自动模式会失控。
3. **视口内翻译**：自动模式只翻「视口 ±1 屏」，不翻整个 DOM。
   一个 10k 块的长页面自动全翻，无论哪个引擎都不可接受。
4. **每日预算**：AI 引擎自动模式下设每日字符上限，超了退回手动并提示。
5. **付费功能永不自动**：PDF、漫画（账号额度）—— 自动的只能是「入口出现」，不能是「任务开始」。
6. **隐私边界**：自动翻译意味着页面内容在用户没点任何按钮的情况下被发往第三方 API。
   `never` 规则必须内置一批默认值（网银、`localhost`、`*.内网`、密码管理器），
   并且商店描述里要说清楚。这条是上架风险，不只是产品风险。

---

## 8. 路线图

| 阶段 | 内容 | 产出 | 依赖 |
| --- | --- | --- | --- |
| **P0 地基** | `shared/site-rules.js`（纯函数决策）+ `content/content-auto-translate.js`（MutationObserver + IntersectionObserver + 队列）+ `shared/spa-navigation.js`（从漫画抽出）+ 翻译缓存 + `translatePage()` 静默模式 | 任意站点「打开即翻 + 滚动继续翻 + 换路由重翻」 | 无 |
| **P1 规则与 UI** | 内置规则表（X / Reddit / HN / arXiv / GitHub…）+ 悬浮球上的「总是翻译此站 / 永不」三态 + 设置页站点列表 + `chrome.commands`（Alt+A / Alt+W） | 用户能管自动行为 | P0 |
| **P2 字幕自动开启** | `autoEnableCaptions` 设置 + YouTube `enableNativeCaptions()` + TextTrackProvider 挑轨 + 改 CLAUDE.md 铁律 | YouTube / Coursera / Udemy / edX / TED 打开即双语 | 无（可与 P0 并行） |
| **P3 arXiv 与论文** | arXiv/ar5iv/bioRxiv 内置规则 + arXiv PDF 的「提示条而非自动跑」 | 论文场景闭环 | P0 |
| **P4 长尾** | 字幕文件翻译（复用 caption-core）+ 会议字幕 DOM provider + Shadow DOM 遍历 + iframe（`all_frames`） | 对齐对手的长尾 | P0/P2 |

**建议先做 P0 + P2**：P0 一次性解决 X/Reddit/HN/Gmail/Discord 等全部页面场景，
P2 与它无依赖可并行，而且是用户明确点名的两件事里的另一件。P1 的 UI 可以跟在 P0 后面一周内补。

---

## 9. 对现有约定的影响（动手前必须处理）

1. **CLAUDE.md 的字幕铁律要改**（§4.1）。不改就动代码，等于让文档说谎。
2. **1k 行规则**：`content-page-translation.js` 已经 2282 行，`content-comic-translation.js` 1840 行。
   自动翻译的调度器**必须新开模块**，并且建议借这次把 collect / batch / insert 三段从
   `content-page-translation.js` 拆出去 —— 否则 thermos 的 code-quality 复审必挂。
3. **无历史包袱铁律**：站点规则是新特性，不要为"没有规则的老用户"留兼容分支，
   默认值就是空规则表 + `ask`。
4. **MAIN-world 拦截器不得放宽**：CLAUDE.md 明文禁止把 `youtube-timedtext-interceptor.js`
   的 match 放宽到 `<all_urls>`。B 类视频站要网络观察，各自加自己的 match pattern。
5. **路由感知落在 `shared/spa-navigation.js`**（§3.4）：全仓目前没有任何 history API 监听，这是新代码，别散落在正文模块里。
6. **e2e 需要新 fixture**：无限滚动页、SPA 路由页、shadow DOM 页。
   `test/e2e/test-sites.js` 已有本地站点框架，扩它，不要依赖真站（X 有登录墙，
   `B-F17` 那轮已经吃过这个亏）。

---

## 10. 动手前需要实测确认的三件事

代码静态分析到不了的，必须真机验证后才能定规则：

1. **X 的推文正文现在实际被切成几块？**（验证 §3.5 的碎片化推断）
2. **Reddit 的正文在 light DOM 还是 shadow root？**（决定要不要做 Shadow DOM 遍历）
3. **YouTube 点 `.ytp-subtitles-button` 后，timedtext 拦截器是否稳定拿到 ASR 轨？**
   （决定 §4.2 的覆盖率是"绝大多数视频"还是"只有人工字幕"）
