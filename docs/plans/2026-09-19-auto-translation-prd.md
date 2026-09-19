# PRD · 叭叭翻译 自动翻译（Auto Translation）

| 项 | 内容 |
| --- | --- |
| 版本 | v1.1（已并入第三方评审核验结论） |
| 日期 | 2026-09-19 |
| 目标版本 | 扩展 1.4.0 |
| 关联文档 | [现状与差距分析](./2026-09-19-auto-translation-design.md) · [自动化面与交互设计](./2026-09-19-auto-translation-ux-design.md) · [第三方评审核验与综合](./2026-09-19-parity-review-synthesis.md) · [功能设计与实现文档](./2026-09-19-auto-translation-implementation.md) |
| 影响模块 | `content/`、`shared/`、`popup/`、`options/`、`manifest.json`、`_locales/`（10 语） |

---

## 1. 背景

### 1.1 现状

扩展当前具备完整的翻译能力（整页、划词、悬停、输入框、字幕、OCR、漫画、PDF），
但**全部需要用户手势触发**，且**每次触发只翻译一次**：

- 三个入口都是手动：悬浮球菜单 `content/content-float-ball.js:395`、popup `#translatePage`、右键菜单 `background/background.js:703`。
- 整页翻译是一次性的：`translatePage()`（`content/content-page-translation.js:74`）收集一次 DOM 即结束，
  全仓没有针对正文的 `MutationObserver`，没有 SPA 路由监听。
- 全仓 grep `autoTranslate|alwaysTranslate|autoMode` 零命中。

### 1.2 问题

| # | 问题 | 后果 |
| --- | --- | --- |
| P1 | 每次访问外文页都要手动点两次（悬浮球 → 菜单 → 翻译整页） | 高频用户的主要流失点 |
| P2 | 信息流站点（X / Reddit / 各类 feed）滚动后全是原文 | **在这些站上功能近似不可用**，而这正是用户停留最久的场景 |
| P3 | SPA 换路由后译文消失且不重译 | 现代站点普遍受影响 |
| P4 | 视频字幕开关默认关闭且需观众先手动开 CC | 一个从未被打开过的开关等于不存在 |
| P5 | 无翻译缓存，重复内容重复计费 | AI 引擎下成本不可控 |

### 1.3 为什么是现在

1. **底子已经具备**：译完的源元素带 `.ai-translator-translated` 标记（`content-page-translation.js:1726`），
   收集阶段会跳过它及其子树（`:866`）。**重复调用 `translatePage()` 天然只处理新节点** ——
   增量翻译不需要重写引擎。
2. **成本前提已经成立**：默认引擎是 `builtin`（Chrome 内置 Translator，本地推理、免费、无额度，
   `content-bootstrap.js:41`）。没有它，"默认开启自动翻译"在经济上不成立。
3. **竞品已定义了用户预期**：沉浸式翻译的站点规则 + 双语字幕已是该品类的基线能力。

---

## 2. 目标与非目标

### 2.1 目标

| ID | 目标 | 可验证的达成标准 |
| --- | --- | --- |
| G1 | 用户在常去的外文站"打开即已翻好" | 设为自动的站点，页面可交互后 ≤2s 首屏出现译文 |
| G2 | 信息流站点滚动/换路由持续可用 | X / Reddit 滚动 10 屏，新内容全部被翻译，无重复翻译、无死循环 |
| G3 | 开启与关闭的交互成本 ≤1 次点击，且不需要打开设置页 | 见 FR-3 验收 |
| G4 | 视频站"打开即有双语字幕" | YouTube + 至少 2 个标准 `<track>` 站点验证通过 |
| G5 | 默认配置下不产生任何付费开销 | 自动模式默认 `builtin`；付费路径（PDF / 漫画）无任何自动触发 |

### 2.2 非目标（本版本明确不做）

- 视频 ASR（无字幕轨的视频自行转写）—— 另见 backlog `B-F17-2`。
- Netflix / Prime / Disney+ 等 DRM 播放器的字幕 provider。
- EPUB 阅读（归 saas 侧阅读台，不在扩展内重做）。
- 自动 OCR 页面内所有图片（成本与噪声均不可接受）。
- 翻译质量本身的改进（本 PRD 只改"何时翻"，不改"翻得怎么样"）。
- 任何形式的用户行为上报 / 遥测。

---

## 3. 用户与场景

### 3.1 用户画像

| 画像 | 特征 | 核心诉求 |
| --- | --- | --- |
| A · 信息流读者 | 每天泡 X / Reddit / HN，外语能读但慢 | 别让我一条条点；滚动别断 |
| B · 研究者 / 学生 | arXiv、论文站、教育视频 | 论文和课程视频要能直接读/看 |
| C · 谨慎用户 | 关心隐私与费用 | 别偷偷把我的页面发出去；别花我的钱 |

### 3.2 核心用户故事

| ID | 故事 | 对应需求 |
| --- | --- | --- |
| US-1 | 作为 A，我打开 x.com 就能看到中文，往下滚新推文也自动是中文 | FR-1, FR-2, FR-4 |
| US-2 | 作为 A，我在一个新站手动翻了一次，它问我"以后自动翻这个站吗"，我点"总是"就再不用管了 | FR-3 |
| US-3 | 作为 A，某一页我想看原文，点一下悬浮球就还原，再点回来 | FR-3 |
| US-4 | 作为 A，我在某个站开错了，能在这个站上直接关掉，不用去设置页找 | FR-3 |
| US-5 | 作为 B，打开 arXiv 摘要/HTML 全文即是中文；PDF 不会偷偷消耗我的额度 | FR-6, FR-10 |
| US-6 | 作为 B，打开 YouTube / Coursera 视频就有双语字幕 | FR-5 |
| US-7 | 作为 C，网银和内网页面永远不会被自动翻译 | FR-11 |
| US-8 | 作为 C，我能一键把自动翻译整个关掉，且我的站点设置不丢 | FR-3 |

---

## 4. 成功指标

**坦白前提：扩展当前没有任何遥测/埋点（`analytics|telemetry|gtag` 全仓零命中），本 PRD 也不打算加。**
因此指标分两类，不做"留存率""DAU"这类拿不到的数字。

### 4.1 可自动验证的（进 e2e，作为发布门槛）

| 指标 | 门槛 |
| --- | --- |
| 自动翻译触发到首屏译文出现 | ≤2s（本地 fixture，builtin 引擎） |
| 增量翻译重复翻译率 | 0（同一元素不得被翻译两次） |
| 滚动 10 屏后遗漏块数 | 0 |
| SPA 路由切换后重译成功率 | 100%（本地 fixture） |
| 默认配置下付费接口调用次数 | 0 |
| 自动模式下对 `never` 站点的引擎调用次数 | 0 |

### 4.2 可本地自查的（给用户看，不上报）

设置页显示**本机**统计：本月自动翻译页数、缓存命中率、AI 引擎已用字符数 / 预算。
这既是用户的成本可见性，也是我们唯一诚实的效果观察窗口。

### 4.3 定性

商店评价与用户反馈中"需要手动点"" feed 翻不全"类抱怨消失。

---

## 5. 产品模型（一页纸）

```
                        ┌──────────────────────────┐
                        │  shared/site-rules.js    │  唯一真相源
                        │  autoTranslate: true     │  全局闸门
                        │  siteRules: {host: 态}   │  ask / always / never
                        │  decide(...) → auto|ask|off │
                        └────────────┬─────────────┘
                                     │ 五个面读同一个答案
        ┌───────────┬────────────┬───┴────┬────────────┬──────────┐
        ↓           ↓            ↓        ↓            ↓
     S1 正文    S2 字幕     S3 输入框   S4 文件    S5 图像/漫画
     打开即译   打开即有    提示译成    拖入即译   只出现入口
     滚动续译   双语字幕    目标语                 绝不自动跑
```

**一个域名，一个答案。** 用户在 youtube.com 关掉自动翻译，字幕也随之不翻 ——
不允许出现"正文关了但字幕还在翻"这种用户无法理解、也无法自行修复的状态。

---

## 6. 功能需求

优先级：**P0** = 1.4.0 必须；**P1** = 1.4.0 应该；**P2** = 后续版本。

---

### FR-1 站点规则与决策 【P0】

**需求**：提供一个纯函数决策层，回答"这个页面现在该不该自动翻译"。

**细则**
1. 新模块 `shared/site-rules.js`，导出纯函数：
   `decide({ host, path, pageLang, targetLang, rules, settings }) → 'auto' | 'ask' | 'off'`
2. 域名三态：`ask`（默认）/ `always` / `never`。**不设第四态**（不做"仅本次会话""仅此路径"）。
3. 匹配粒度 = 注册域（`x.com` 命中 `mobile.x.com`）。路径级例外只存在于内置规则表，用户不可配。
4. 决策顺序（短路）：
   全局闸门关 → `off` ｜ 内置黑名单命中 → `off` ｜ 用户 `never` → `off` ｜
   用户 `always` → `auto` ｜ 内置 `always` → `auto` ｜ 页面语言 == 目标语言 → `off` ｜ 其余 → `ask`
5. 内置规则表 `shared/site-rules-builtin.js`（数据，非逻辑），字段：
   `match`、`state`、`atomicBlockSelectors?`、`selectors?`、`excludeSelectors?`、`stayOriginalSelectors?`。
   **不提供** `injectedCss`、`translationDelay`、每站引擎等字段 —— 不需要就不建模。
6. **优先级四级（冲突时的唯一裁决口径）**：
   **当前页显式动作 > 站点/路径规则 > 语言规则 > 全局默认**。
   具体含义：用户在当前页点了"翻译"，就**跳过**第 4 条里"页面语言 == 目标语言"的短路
   —— 他知道自己在做什么。语言规则只约束**自动**触发，不约束手动触发。
7. 内置规则表随扩展打包，是**带 schema 与版本号的声明式数据**：
   `{ schemaVersion, rulesVersion, rules: [...] }`，加载时按 schema 校验，
   校验失败整表回退到上一版本（内置兜底表）。**永远不下发可执行 JS**
   （Chrome remote-hosted-code 政策）。

**验收**
- [ ] `decide()` 有单测覆盖全部 6 条短路分支（`test/unit/`）。
- [ ] 优先级四级有单测：语言规则说"跳过"时，显式点击仍然翻译。
- [ ] 规则表 schema 校验失败时回退到兜底表，不崩溃、不空表。
- [ ] 全局闸门关闭时，任何输入都返回 `off`。
- [ ] 内置黑名单优先级高于用户 `always`。

---

### FR-2 页面自动翻译（首次 + 增量 + 路由）【P0】

**需求**：`decide()` 返回 `auto` 时静默翻译页面，并在页面继续生长/换路由时持续翻译。

**细则**
1. 新模块 `content/content-auto-translate.js`（调度器，**不重写翻译引擎**）。
2. **首次触发时机**：`document_end` 后 + `requestAnimationFrame` + 250ms 防抖。
   过早会撞上 SSR→hydration 的整片替换（X / Reddit 首屏会被重建）。
3. **页面语言判定**：取首屏最靠前的 5–8 个候选块正文拼接 → `chrome.i18n.detectLanguage`
   → 置信度 ≥85% 才采信（与 `isTargetLanguageText()` 同一阈值，**不得新增第二套阈值**）。
   判不出 → 按 `ask` 处理，不赌。
4. **增量**：`MutationObserver(document.body, {childList:true, subtree:true})`
   → 400ms 防抖 → 新增子树经 `IntersectionObserver` 过滤，仅"视口 ±1 屏"内入队 → 队列非空则调度。
5. **自译回环防护**：插入译文期间挂起观察器，或按 `.ai-translator-*` 前缀过滤 records。**必须有 e2e 覆盖。**
6. **并发**：`state.isTranslatingPage`（`:84`）当前会把并发调用变成"闪一下提示"。
   自动模式下必须改为**排队**：本轮结束后检查队列是否有新块。
7. **静默模式**：`translatePage({ quiet: true })` —— 不弹进度条、不弹完成提示，
   状态只通过悬浮球体现（见 FR-3）。
8. **SPA 路由**：新增 `shared/spa-navigation.js`。
   全仓目前**没有任何 history API 监听**（`content-comic-translation.js:1004` 只是一句注释，
   说的是漫画站自己 patch 了 pushState；我们的应对是监听 `<img>` 的 `src` 变化）。
   因此这是全新代码，但必须落在 `shared/`：字幕、漫画、未来的面都会需要同一个信号，
   不得在正文模块里就地实现（CLAUDE.md Coherence 条款）。
   **实现方式已修订（2026-09-19）**：本条初稿写的是"订阅 `pushState` / `replaceState`"，
   这在 MV3 下**不成立** —— content script 跑在 ISOLATED world，
   与页面共享 DOM 但不共享 JS 全局与原型，在隔离世界里改 `History.prototype.pushState`
   对页面自己的调用完全无效。实际方案是三路并用：浏览器派发的 `popstate` / `hashchange`
   （隔离世界收得到）+ Navigation API（`window.navigation`，存在即用）+ URL 轮询兜底，
   按目标 URL 250ms 内合并去重。详见[实现文档](./2026-09-19-auto-translation-implementation.md) §2.5。
9. 失败沿用现有 `MAX_BATCH_FAILURES = 3` 熔断；自动模式下熔断后**不弹错误**，
   仅在悬浮球状态点上标记异常。
10. **内容身份（不是节点身份）**。现有幂等完全依赖源元素上的
    `.ai-translator-translated`（打标 `content-page-translation.js:1726`，
    跳过 `:866-867`）—— 那是**节点**身份。X / Reddit 的虚拟列表会回收 DOM 节点：
    class 还在、文本已换成另一条推文，新内容会被**静默跳过**。
    改为在源元素上记两个属性：

    ```
    data-bt-block  稳定块 ID（站点适配器提供，如推文 ID；无适配器时按 DOM 路径生成）
    data-bt-hash   规范化正文的短 hash
    ```

    跳过条件改为 `data-bt-hash === hash(当前正文)`；hash 不匹配 = 节点被复用，
    先移除旧译文节点再当作新块入队。**class 保留给样式，不再承担幂等职责。**
11. **会话代次（迟到响应污染）**。`sessionVersion` 在以下事件自增：
    路由变化、目标语言变化、引擎变化、用户恢复原文、用户暂停。
    每个翻译请求携带 `{ sessionVersion, blockId, textHash }`，响应回来三项全过才插入：
    节点仍 `isConnected`、`textHash` 与请求时相同、`sessionVersion` 相等。
    字幕侧的跨视频污染用**同一个机制**（FR-5），不得另写一套。
12. **并发按引擎取值**，不再用固定的 `CONCURRENCY = 12`（`:24`）：
    内置引擎是同进程串行开销，云端引擎是网络并发，同一个数字两边都不对。
    建议 `builtin: 4 / ai: 12`，可调，落在一处常量表里。

**验收
- [ ] 本地 fixture：无限滚动页滚动 10 屏，新内容全部被翻译，无元素被翻译两次。
- [ ] 本地 fixture：SPA 路由切换 3 次，每次都重新判定并翻译。
- [ ] 本地 fixture：**虚拟列表**回收节点（同一 DOM 节点换成另一条内容），新内容被翻译、
      不沿用旧译文；反复滚动 100 条不出现错配。
- [ ] 翻译请求在途时切换目标语言 / 恢复原文，迟到响应**不写回**页面。
- [ ] 注入 10k 节点的 DOM 爆发，不出现观察器死循环（CPU 占用回落）。
- [ ] 自动模式下不出现任何进度条 / toast。

---

### FR-3 启用与关闭的交互 【P0】

**需求**：用户只需要学会一件事 —— 悬浮球是开关。全部交互只有四个触点。

#### FR-3.1 触点一 · 自动翻译发生时：不弹任何东西
悬浮球即状态指示器：普通态 / 右上角小点（本站为 `always`）/ 细进度环（翻译中，≤2s 消失）。
**不做横幅、不做 toast、不做"已为您自动翻译"。**

#### FR-3.2 触点二 · 启用：一次追问
在 `ask` 态站点**手动**翻完整页后，悬浮球旁浮出单行条，5s 无操作自动消失：

```
   ┌───────────────────────────────────────┐
   │  以后自动翻译 x.com？   总是    不用   │
   └───────────────────────────────────────┘
                                      ( ⇄ )
```
- 「总是」→ `always`；「不用」→ `never`；不理 → 保持 `ask`。
- **同一域名累计 3 次不回应后永久静默**（记 `askCount`）。
- 这是**唯一**的启用路径；用户不需要知道"站点规则"这个概念。

#### FR-3.3 触点三 · 关闭：区分两种"关"

| 用户意图 | 动作 | 效果 |
| --- | --- | --- |
| 这一页想看原文 | 点悬浮球 | 还原原文，**不改规则**；再点译回来 |
| 这个站以后别自动翻 | 悬浮球菜单**第一项**「不再自动翻译 x.com」（仅 `always` 时出现） | 置 `never` 并立即还原 |

#### FR-3.4 触点四 · 全局闸门
popup 顶部一行「⚡ 自动翻译 [开/关]」，复用现有 `kbd` 状态芯片形态
（`popup/popup.html:34`、`:43` 已是该形态）。关闭 = 所有 `always` **暂停但不丢失**。

#### FR-3.5 设置页 = 审计，不是配置
仅两块：① 已保存站点表（域名 + 状态 + ✕ 删除，用于清理误操作）；
② 高级项（默认折叠）：自动模式引擎、自动翻译语言范围、AI 每日预算。
**设计目标：普通用户从装上到用熟，一次都不需要打开这一页。**

**验收**
- [ ] 从"从未访问过的外文站"到"该站以后自动翻译"，总点击数 ≤3（翻译 + 总是 = 2 次点击 + 1 次菜单）。
- [ ] 关闭某站自动翻译，全程不离开当前页面。
- [ ] 全局闸门关闭再开启，已保存站点规则完全保留。
- [ ] 追问条在同一域名出现第 4 次时不再出现。
- [ ] 自动翻译期间无任何弹出层（e2e 断言 DOM 中不存在 toast 节点）。

---

### FR-4 信息流站点适配 【P0】

**需求**：X 与 Reddit 上译文不碎、不漏。

**细则**
1. **X**：推文正文 `[data-testid="tweetText"]` 内部是一串 `<span>`；当前 `SPAN` 在 `inlineTags` 中、
   `DIV` 是容器会下探，**一条推文会被切成多片分别送翻**（此缺陷现在手动翻译时就已存在）。
   → 内置规则须支持 `atomicBlockSelectors`：命中元素整体成块，**禁止向下拆分**。
   这是规则表里**第一个必须实现的字段**，优先级高于 `selectors`。
2. **Reddit**：新版为 `<shreddit-*>` Web Components。**须先真机实测**正文在 light DOM 还是 shadow root：
   - light DOM → 加 `selectors` 即可；
   - shadow root → 需为 `processElement` 增加 shadow 遍历（`el.shadowRoot` 递归），这是**通用能力**，不止 Reddit 受益。
3. 首批内置 `always` 站点：X、Reddit、Hacker News、Lobsters、arXiv（`/abs/`、`/html/`）、ar5iv、
   bioRxiv、Hugging Face Papers。其余站点一律 `ask`，由用户自己攒。

**验收**
- [ ] X fixture：一条含链接、话题标签、emoji 的推文被作为**单块**翻译（e2e 断言块数 = 1）。
- [ ] Reddit fixture：帖子正文与评论均被翻译。
- [ ] 内置 `always` 站点首次访问即自动翻译，不出现追问条。

---

### FR-5 视频字幕自动化 【P1】

**需求**：打开视频即有双语字幕；必要时自动打开播放器字幕。

**细则**
1. 新设置 `autoEnableCaptions`，**默认关闭**。这是**唯一保留的独立开关**，
   因为它有副作用（改动页面播放器状态），必须单独同意。
2. YouTube：provider 增加 `enableNativeCaptions()` —— `.ytp-subtitles-button` 的
   `aria-pressed === 'false'` 时点击一次。YouTube 自动生成字幕同样走 timedtext，CC 一开即可拦到。
3. 通用 `TextTrackProvider`：允许从 `disabled` 轨中挑一条设为 `hidden`。
   挑选优先级：与视频声道语言一致 > 带 `default` 属性 > 列表第一条。
   **detach 时必须原样还原**（现有 `restoreMode` 契约不得破坏）。
4. **用户手动关掉自动打开的字幕后，本次会话不再自动打开**（与现有"观众关掉的轨不还原"精神一致）。
5. `enableYoutubeCaptionTranslation`（现默认关）**并入全局自动翻译闸门**；
   站点规则对视频站同样生效（youtube.com 设 `never` ⇒ 字幕也不翻）。
6. **必须同步修改 `CLAUDE.md`** 中「We translate the subtitles the viewer already has on;
   we never turn subtitles on」一节，写清新规则与变更理由。不改文档就改代码 = 让文档说谎。

**验收**
- [ ] `autoEnableCaptions` 关闭时，行为与今天完全一致（回归保护）。
- [ ] 开启后：YouTube 未开 CC 的视频，进入后自动出现双语字幕。
- [ ] 开启后：标准 `<track>` fixture 的 `disabled` 轨被提升为 `hidden` 并翻译；detach 后轨状态还原。
- [ ] 用户手动关闭字幕后，同一会话内不再被自动打开。
- [ ] `CLAUDE.md` 相应段落已更新。

---

### FR-6 学术站点 【P1】

**细则**
1. arXiv `/abs/`、`/html/`、ar5iv、bioRxiv、Nature、Science、Google Scholar、HF Papers
   → 内置 `always`，走 FR-2，**零新增翻译代码**（LaTeXML 适配已存在）。
2. arXiv `/pdf/`（`background/background.js:813` 的 `isLikelyPdfUrl` 已能识别）
   → **路径级 never**，不自动触发。改为在页面上给一条轻量提示条：
   「翻译这篇论文（约消耗 N 页额度）」，**点击才跑**。

**验收**
- [ ] arXiv `/abs/` 与 `/html/` 首次访问即自动翻译。
- [ ] arXiv `/pdf/` 页面：无任何自动网络请求发往 PDF 任务接口（e2e 断言）。

---

### FR-7 翻译结果缓存 【P0】

**需求**：同样的文本不重复送翻。

**细则**
1. `key = hash(normalizedText + sourceLang + targetLang + engine + modelId + promptVersion + glossaryVersion)`。
   **`promptVersion` / `glossaryVersion` 不能省**：改了提示词或换了术语库之后，
   旧键会继续供应按旧口径译出的结果，而且没有任何征兆。
2. 两级：进程内 LRU（上限 ~2000 条）+ `chrome.storage.local` 持久化。
3. **30 天过期清理**，由现有 `chrome.alarms` 机制驱动（已有 `PDF_POLL_ALARM` 先例）。
4. 存储上限保护：超过阈值按 LRU 淘汰，**绝不无限增长**。

**理由**：信息流场景重复率极高（转推引用、重复回帖、翻页回访）。没有缓存，
AI 引擎下的自动模式成本不可控；这是 FR-9 成本闸门成立的前提。

**验收**
- [ ] 同一页面连续翻译两次，第二次引擎调用次数为 0。
- [ ] 改动 `promptVersion` 后，同一文本不再命中旧缓存。
- [ ] 缓存条目超过 30 天后被清理。
- [ ] 存储占用有上限，超限触发淘汰。

---

### FR-8 输入框语言提示 【P2】

输入内容语言 ≠ 页面语言时，输入框右下角出现极小的「译成 EN」芯片，**点击才译**。
**永不自动改写用户输入。**

---

### FR-9 成本与预算闸门 【P0】

| 规则 | 说明 |
| --- | --- |
| 自动模式默认引擎 = `builtin` | Chrome 内置 Translator：本地、免费、无额度。这是"默认开启"能成立的唯一前提 |
| AI 引擎用于自动模式 | **默认关闭**，开启需二次确认并展示成本说明 |
| AI 自动模式每日字符预算 | 超出后自动退回手动模式并提示一次 |
| 仅翻译视口 ±1 屏 | 长页面（万级块）自动全翻，任何引擎都不可接受 |
| 付费功能永不自动 | PDF / 漫画：可自动的只有"入口出现"，绝不能是"任务开始" |
| **引擎回退必须显式** | 见下 |

#### FR-9.1 引擎回退不得静默（第三方评审 §3.4 核验成立）

`content/content-translation-engine.js:684-709`：内置引擎不可用（Chrome 版本过低、
`http://` 页面的非安全上下文、语言对不支持）且用户配过 AI Key 时，
**当前会静默改用用户的接口**，界面上没有任何痕迹（只有一句 `console.info`）。

手动模式下这不算问题 —— 是用户点的翻译。**自动模式下它是新问题**：

> 用户配过 BYOK Key（为了偶尔用 AI 重译），之后在一个 `http://` 站点打开自动翻译，
> 整页内容会在**零点击**的情况下发往他自己的付费接口。

因此本 PRD 的"默认零计费"只在"没配 Key"这一严格默认态下成立，不能作为通用承诺。

**规则**
1. 设置页新增二选一：**「仅本地引擎」（默认） / 「本地不可用时允许用我配置的接口」**。
2. 选"仅本地"时，内置引擎不可用 = 不自动翻译（悬浮球状态点标记，不弹窗）。
3. 允许回退时，**每次实际发生回退**都要有可见痕迹：悬浮球状态点变色，
   点开说明"本地引擎不可用（原因），本次使用了你配置的接口"。
4. 该设置对手动翻译同样生效 —— 不得给自动/手动两条路各留一套回退策略。

**验收**
- [ ] 无 Key 的默认配置下，自动翻译全程不调用任何计费接口。
- [ ] **配了 Key 且选「仅本地」时**，`http://` 页面的自动翻译不发起任何网络请求。
- [ ] 允许回退且实际回退时，界面上能看出这次用的不是本地引擎。
- [ ] AI 引擎自动模式达到预算上限后停止并提示。
- [ ] 10k 块的长页面，自动模式首轮翻译块数 ≤ 视口 ±1 屏内的块数。

---

### FR-10 付费面边界 【P0】

```
   可以自动：入口出现   ← 规则识别为漫画站 → 悬浮球长出「翻译这页漫画」
   绝不自动：任务开始   ← 扣额度的动作永远需要一次明确点击
```
**验收**：e2e 断言默认配置下 comic / PDF 任务接口零调用。

---

### FR-11 隐私与合规 【P0】

**需求**：自动翻译意味着页面内容在用户未点击任何按钮的情况下被发往翻译引擎。这是上架风险，不只是产品风险。

**细则**
1. 内置 `never` 黑名单（用户不可删）：网银与支付域、`localhost`、私有网段 IP、
   密码管理器域、企业 SSO 登录页。
2. `builtin` 引擎为本地推理，不出网 —— 这一事实应在设置页与商店描述中明确说明。
3. AI 引擎（出网）用于自动模式时，首次开启必须展示明确提示。
4. 商店描述与隐私政策同步更新，说明自动翻译的触发条件与数据流向。

**验收**
- [ ] 黑名单域名下，任何配置组合都不会自动翻译（含用户误设 `always`）。
- [ ] 首次开启"AI 引擎 + 自动模式"组合时出现一次性说明。

---

### FR-12 快捷键 【P1】

`Alt+A` = 与悬浮球单击**完全同义**（翻译 / 还原）。manifest 新增 `commands`。
**只做一个快捷键**：竞品的第二个（强制翻全页）应由内置规则解决，不该让用户用快捷键绕过。

---

## 7. 数据模型

```jsonc
// chrome.storage.sync（跨设备同步，体积敏感）
{
  "autoTranslate": true,                    // 全局闸门
  "siteRules": { "x.com": "always", "example.com": "never" },
  "autoTranslateEngine": "builtin",         // builtin | ai
  "autoTranslateLangs": [],                 // 空 = 除目标语言外全部
  "autoEnableCaptions": false,              // 副作用开关，独立
  "aiAutoDailyBudget": 200000               // 字符/天，仅 AI 引擎生效
}

// chrome.storage.local（本机，可增长）
{
  "siteAskCount": { "example.com": 2 },     // 追问次数，≥3 永久静默
  "translationCache": { "<hash>": { "t": "译文", "ts": 1758240000000 } },
  "autoStats": { "month": "2026-09", "pages": 312, "cacheHit": 0.61, "aiChars": 18420 }
}
```

**约束**
- `siteRules` 只存用户**显式**设过的域名；内置规则不落盘（避免 sync 配额膨胀）。
- `sync` 单项 8KB 上限：`siteRules` 超过 ~200 条时提示用户清理（设置页审计表的用途之一）。
- **默认值当前在 `content/content-bootstrap.js` 中重复了三处（`:41`、`:121`、`:153`）。
  新增键不得沿袭这个模式**，应借本次收敛为单一来源。

---

## 8. 交互规格

完整规格见 [自动化面与交互设计](./2026-09-19-auto-translation-ux-design.md) §2。本节只列约束性结论：

- 状态机三态，**不设第四态**。
- 自动翻译成功时**零弹出**。
- 关闭路径必须在当前页面内完成。
- popup 新增一行，形态复用现有 `kbd` 芯片。
- 设置页只用于审计与高级项，不作为主要配置入口。
- i18n：新增文案需覆盖 `_locales/` 全部 10 个语言（de/en/es/fr/ja/ko/pt_BR/ru/zh_CN/zh_TW），
  同时更新 `i18n/messages.js`。

---

## 9. 技术约束与架构要求

| # | 约束 | 出处 |
| --- | --- | --- |
| C1 | **1k 行文件规则**：`content-page-translation.js` 已 2282 行、`content-comic-translation.js` 已 1840 行。自动翻译逻辑**必须新开模块**，并建议借机把 collect / batch / insert 三段拆出 | thermos 代码质量规约 |
| C2 | **无历史包袱铁律**：站点规则是新特性，**不得**为"没有规则的老用户"留兼容分支。默认即空规则表 + `ask` | CLAUDE.md |
| C3 | **路由感知只能有一份**：`shared/spa-navigation.js` 为唯一实现（全仓现无 history API 监听），各面订阅，不得在正文/字幕模块内各写一份 | CLAUDE.md Coherence |
| C4 | **MAIN-world 拦截器 match 不得放宽到 `<all_urls>`** | `translator/CLAUDE.md` |
| C5 | **宿主页 CSS 隔离带**：新面板根节点须加入 reset 的 `:is()` 列表，禁用 `!important` | `translator/CLAUDE.md` |
| C6 | 语言判定阈值只有一处（85%），不得新增第二套 | `isTargetLanguageText()` |
| C7 | 所有 API / 参数规则只存在于 `shared/api-compat.js` | `translator/CLAUDE.md` |
| C8 | e2e 必须使用本地 fixture（`test/e2e/test-sites.js`），**不得依赖真实站点**（X 有登录墙，`B-F17` 已吃过亏） | 历史教训 |
| C9 | 每个完成的改动走一个 PR（`github_pr_workflow.py`） | CLAUDE.md |

**新增模块清单**

```
shared/site-rules.js            决策纯函数（可单测）
shared/site-rules-builtin.js    内置规则表（纯数据）
shared/spa-navigation.js        路由订阅（新建，全仓现无同类实现）
shared/translation-cache.js     两级缓存 + 过期清理
content/content-auto-translate.js   调度器（观察器 + 队列 + 静默模式）
content/content-auto-prompt.js      追问条 + 状态点 UI
```

---

## 10. 非功能需求

| 项 | 要求 |
| --- | --- |
| 性能 | 自动翻译不得阻塞首屏渲染；观察器回调需防抖；空闲时 CPU 占用回落至基线 |
| 内存 | 缓存有上限并按 LRU 淘汰；观察器在页面卸载时断开 |
| 兼容 | `minimum_chrome_version` 需与默认引擎对齐（见 M0-c / D4）：当前 `manifest.json:7` 写 116，而内置 Translator API 要 138 —— 116–137 的用户装得上、默认引擎永远不可用。`builtin` 不可用时降级为"不自动翻译"并在设置页说明 |
| 可测试性 | `decide()` 与缓存为纯逻辑，必须有单测；调度器行为由 e2e fixture 覆盖 |
| i18n | 10 语言全覆盖 |
| 可回退 | 全局闸门关闭后，扩展行为须与 1.3.1 完全一致（回归基线） |

---

## 11. 发布计划

> M0 由第三方评审核验补入（见 [核验与综合](./2026-09-19-parity-review-synthesis.md) §6）。
> 它的存在理由很简单：**"自动翻译默认开"的前提是"默认就能翻出来"**，
> 而现在新用户拿到的是一句与实际问题无关的报错。

| 里程碑 | 内容 | 出口标准 |
| --- | --- | --- |
| **M0 新用户能开始** | 见下表 M0-a…M0-e | Chrome 138 全新安装、不登录、不填 Key，打开英文页能出译文，popup 不报错 |
| **M1 地基** | FR-1 决策层、FR-2 调度器、FR-7 缓存、`shared/spa-navigation.js` | 本地 fixture：打开即译 / 滚动续译 / 路由重译 全绿 |
| **M2 交互** | FR-3 全部四个触点、FR-9 成本闸门、FR-11 黑名单 | 启用 ≤3 次点击、关闭不离开页面、默认零计费 |
| **M3 站点与字幕** | FR-4 信息流适配、FR-5 字幕自动化（含 `CLAUDE.md` 修订）、FR-6 学术站 | X 推文单块、YouTube/`<track>` 自动双语字幕 |
| **M4 收尾** | FR-12 快捷键、设置页审计表与统计、开关收敛、商店描述与隐私政策更新 | 全量回归 + 商店材料就绪 |

**M0 工作包（全部为既有缺陷，先于新功能）**

| # | 问题 | 落点 | 出口标准 |
| --- | --- | --- | --- |
| M0-a | `checkStatus()` 无条件按 `!apiKey` 报错，而默认引擎本就免 Key | `popup/popup.js:485`（正确写法就在同文件 `:504`） | 状态按当前引擎真实可用性算，四态：本地就绪 / 准备语言包 / 环境不支持（给云端与 BYOK 出路）/ BYOK 缺配置 |
| M0-b | UI 语言被翻译目标语言绑架 | `i18n/messages.js:2873` + 5 处调用（`background:226`、`popup:42`、`options:44`、`pdf/upload:54`、`content-bootstrap:95`） | 拆成 `uiLanguage` / `targetLanguage` / `writingTargetLanguage`；改翻译语言不改界面语言 |
| M0-c | `minimum_chrome_version: 116` 与默认引擎所需的 138 不一致 | `manifest.json:7` | 见 D4，两条路二选一，必须定 |
| M0-d | 引擎回退静默 | `content-translation-engine.js:684-709` + 设置页 | FR-9.1 |
| M0-e | `autoDetect` 名实不符（实为"跳过已是目标语言的内容"） | `options/` + `content-bootstrap.js` 三处默认值 | 改名后与新的自动翻译开关语义不再打架；顺带把三处重复默认值收敛为一处（§7 约束） |

每个里程碑一个 PR；M3 前需完成 §13 的三项实测。

**M1 增补**（评审核验）：内容身份 FR-2.10、会话代次 FR-2.11、并发按引擎 FR-2.12、缓存键补齐 FR-7.1。
**M2 增补**：FR-9.1 显式回退。
**M3 增补**：字幕改滑动窗口预译（现 `content-video-captions.js:465` 预译整轨）、
字幕失败态分类（无字幕 / CC 未开 / 请求失败 / 429 / 语言包 / 翻译失败，空白不能同时代表全部）、
字幕尾部 cue 卡死加固（见 §13.3）。

---

## 12. 风险与缓解

| # | 风险 | 影响 | 缓解 |
| --- | --- | --- | --- |
| R1 | 自动翻译在 AI 引擎下产生意外费用 | 高 | 默认 `builtin`；AI 自动模式二次确认 + 每日预算 + 缓存（FR-7/FR-9） |
| R2 | MutationObserver 与自插译文形成死循环 | 高 | 插入期挂起观察器 + 前缀过滤；**必须有 e2e 覆盖**（FR-2.5） |
| R3 | 隐私争议 / 商店审核受阻 | 高 | 内置黑名单 + 本地引擎默认 + 商店描述与隐私政策同步（FR-11） |
| R4 | X / Reddit DOM 结构变更导致规则失效 | 中 | 规则表是纯数据，可单独小版本更新；通用启发式为兜底，规则失效时退化为"翻得碎"而非"翻不了" |
| R5 | 自动打开字幕破坏播放器状态 | 中 | 默认关闭；detach 严格还原；用户手动关闭后本会话不再自动开（FR-5） |
| R6 | 增量翻译在重型站点造成卡顿 | 中 | 防抖 + 视口过滤 + 熔断沿用；空闲 CPU 回落纳入验收 |
| R7 | `content-page-translation.js` 继续膨胀导致质量复审不过 | 中 | C1：新逻辑一律新模块，并在本轮拆分既有文件 |

---

## 13. 待决策 / 待实测

### 13.1 待产品决策

| # | 问题 | 选项 | 倾向 |
| --- | --- | --- | --- |
| D1 | ~~悬浮球单击语义~~ **已定案 (a)** | (a) 改为「翻译 / 还原」切换，菜单移至 hover 的 `···`（触屏长按）；(b) 保持单击开菜单 | **(a) 定案**。第三方评审 §6.3 独立给出同一结论（单击翻译/恢复 + 小箭头开菜单），两侧收敛。当前 `content-float-ball.js:324` 单击开菜单 = 翻译要点两次 |
| D2 | 全局 `autoTranslate` 默认值 | (a) 默认开 + 站点默认 `ask`；(b) 默认关 | **(a)**。默认关的自动化等于不存在（`enableYoutubeCaptionTranslation` 即活例）；真正的保护是 builtin 默认 + 黑名单 + 预算，不是默认关 |
| D3 | 首批内置 `always` 站点范围 | 保守（仅学术站）/ 中等（本 PRD 列表）/ 激进 | 中等 |
| D4 | **`minimum_chrome_version` 与默认引擎的矛盾** | (a) 116 → 138，放弃 116–137 的安装量；(b) 保留 116，安装后按 `isBuiltinSupported()` 探测结果把默认引擎降级，并在 popup/设置页明说"这个浏览器版本用不了本地翻译，请配置接口或升级 Chrome" | **(b)**。能力探测已经有了（`content-translation-engine.js:64-69` 探的是 `self.Translator`/`isSecureContext`，不是版本号），缺的只是把探测结果如实说出来；直接抬高门槛会误伤 Edge 等版本号口径不同的内核 |
| D5 | popup 信息架构收敛到几行 | 评审 §6.2 给了 9 行控制面板；本 PRD 主张一行开关 | **四行**：①当前站点＋引擎真实状态 ②翻译/恢复 ③本站自动翻译 ④暂停本页。其余留设置页与悬浮球菜单 —— popup 不该变成第二个设置页（用户原话：交互越简单越好） |

### 13.2 M3 之前必须真机实测

1. **X 的推文正文当前实际被切成几块？**（验证 FR-4.1 的碎片化推断 —— 目前为静态代码推断）
2. **Reddit 正文在 light DOM 还是 shadow root？**（决定是否需要实现 Shadow DOM 遍历这一通用能力）
3. **YouTube 点击 `.ytp-subtitles-button` 后，timedtext 拦截器能否稳定拿到 ASR 轨？**
   （决定 FR-5 的覆盖率是"绝大多数视频"还是"仅人工字幕视频"。
   现状：`content-caption-providers.js:100` 读 `aria-pressed` 判断原字幕是否已开，
   `shared/caption-core.js:309 pickSubtitleTrack()` 从不激活 `disabled` 轨 ——
   即评审 §5.3.2 的"双开关困惑"）

### 13.3 已核验为"非线上缺陷"但需加固的项

评审 §5.3.7 指出 `content-video-captions.js:408 translateCues()` 按下标回填且不校验条数。
代码事实成立，但**当前两条引擎路径都已保证条数相等**：
AI 路径在 `background/background.js:1887` 发现分隔符段数 ≠ 输入数即整批回退编号法
（注释详述过"错开一位"的事故），内置路径 `content-translation-engine.js:641-661` 逐条 push。

真正残留的风险是另一件事：万一出现短数组，`:410 if (!cue) return` 只挡溢出，
**尾部 cue 会永久留在 `state.pendingKeys` 里**（`isSegmentTranslatable()` 见 pending 即跳过），
既不重试也不显示 —— 表现为"某几句字幕永远空白"。

处置：**P2 加固**，在 `translateCues()` 开头加
`if (response.translations.length !== cues.length) { markBatchFailed(cues); return false; }`，
让它走已有的冷却重试路径。不作为 P0。

---

## 14. 附录

### 14.1 术语

| 术语 | 含义 |
| --- | --- |
| 站点三态 | `ask`（不自动翻，翻完后追问）/ `always`（自动翻）/ `never`（不自动翻也不追问；手动翻译仍可用） |
| 全局闸门 | `autoTranslate`，关闭即全部暂停，站点规则不丢失 |
| 自动化面 | 五个可自动化的表面：正文 / 字幕 / 输入框 / 文件 / 图像 |
| 追问条 | 手动翻译完成后出现的单行询问条，唯一的启用路径 |
| 静默模式 | `translatePage({quiet:true})`，无进度条、无完成提示 |

### 14.2 关键代码位置

| 事项 | 位置 |
| --- | --- |
| 整页翻译入口 | `content/content-page-translation.js:74` |
| 块收集 | `content/content-page-translation.js:637` |
| 幂等标记（增量翻译的基础） | `content/content-page-translation.js:866`、`:1726` |
| 视口优先 | `content/content-page-translation.js:465` |
| 逐块语言过滤 | `content/content-page-translation.js:1477` |
| 悬浮球单击 → 菜单 | `content/content-float-ball.js:324` |
| 悬浮球菜单项 | `content/content-float-ball.js:381`–`:432` |
| popup 状态芯片形态 | `popup/popup.html:34`、`:43` |
| 默认设置（三处重复） | `content/content-bootstrap.js:41`、`:121`、`:153` |
| 字幕挑轨（现禁止启用 disabled 轨） | `shared/caption-core.js:309` |
| YouTube CC 状态判断 | `content/content-caption-providers.js:100` |
| arXiv PDF 识别 | `background/background.js:813` |
| 漫画换页检测（`src` 变化，非 history API） | `content/content-comic-translation.js:1004` 注释、`:1031` 观察器 |
