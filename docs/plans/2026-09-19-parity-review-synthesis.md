# 第三方评审《Chrome 插件与沉浸式翻译的功能、交互差距分析》核验与综合

- 日期：2026-09-19
- 评审稿：`~/Downloads/translator-chrome-parity-review.md`（评审基线 `main@3a0e895`，manifest 1.3.1）
- 本地基线：`HEAD 7b02a32`（分支 `chore/prompt-audit`）
- 被综合的三份自有文档：
  - `2026-09-19-auto-translation-design.md`（差距分析）
  - `2026-09-19-auto-translation-ux-design.md`（自动化面 + 交互设计）
  - `2026-09-19-auto-translation-prd.md`（PRD）

评审声明"未在真机跑过"，所以它的价值在**源码级断言**和**产品取舍**两处。以下每条都回到代码核过。

---

## 1. 断言核验（逐条）

| 评审 § | 断言 | 核验 | 代码证据 |
| --- | --- | --- | --- |
| 3.1 | 默认免 Key，popup 仍无条件报"未配置 API" | ✅ **成立，P0 真 bug** | `popup/popup.js:485` `if (!settings.apiKey)` 直接置 `status-error`；同文件 `:504` `translateCurrentPage()` 却写着 `settings.translationEngine === 'ai' && !settings.apiKey`，并附 PR #26 评审注释说明"内置引擎故意免 Key"。同一文件两套口径。 |
| 3.2 | `autoDetect` 只是"跳过目标语言"，不是自动翻译 | ✅ 成立 | `content-page-translation.js:1477 filterBlocksByLanguage()` 是唯一用途。与我方结论一致，**改名建议采纳**。 |
| 3.3 | UI 语言被翻译目标语言绑架 | ✅ **成立，P0** | `i18n/messages.js:2873 getUILanguage(targetLang)`，5 处调用：`background/background.js:226`、`popup/popup.js:42`、`options/options.js:44`、`pdf/upload.js:54`、`content/content-bootstrap.js:95`。中文用户临时译成日语 → 整个界面变日语。 |
| 3.4 | 本地引擎不可用时会静默回退用户的 AI 接口 | ✅ 成立 | `content/content-translation-engine.js:684-709`，`canFallBackToAI()` 为真即 `console.info` 后走 `chrome.runtime.sendMessage`，**用户侧无任何提示**。注释自陈"配了自定义接口就静默顶上"。 |
| 3.4 尾 | "应做能力探测，不能只看浏览器版本" | ⚠️ **能力探测已有；但它顺手点出的 manifest 问题是真的** | `isBuiltinSupported():64-69` 探的是 `self.Translator` / `Translator.create` / `isSecureContext`，不是版本号 —— 这点无需整改。但 `manifest.json:7 minimum_chrome_version: "116"` 而 Translator API 要 138：**116–137 的用户装得上、默认引擎永远不可用、又没 Key**，`:687` 直接返回 `UNSUPPORTED_ENV` 错误。叠加 3.1 的假报错，新用户在这段版本区间上是"装完即坏"。 |
| 4.1 | 没有通用正文增量管线，漫画 MutationObserver 不算 | ✅ 成立 | 全仓唯一的正文侧观察器在 `content-comic-translation.js:1031`，监听 `<img>` 的 `src`。 |
| 4.3 | **虚拟列表：只加 class 不够，必须记内容 ID / 文本 hash** | ✅ **成立，且是我方设计的结构性洞** | 现有幂等完全依赖源元素上的 `.ai-translator-translated`（打标 `:1726`，跳过 `:866-867`）。X 时间线回收 DOM 节点时 class 留着、文本换了 → 新内容被**静默跳过**。我的 FR-2 把"重复调用安全"整个建立在这个 class 上，前提不成立。 |
| 4.3 | 异步过期：请求带 `sessionVersion`/`blockId`/`textHash`，响应回来要校验 | ✅ 成立，我方缺失 | 现有链路只按数组下标回填，无会话代次概念。 |
| 4.3 | 固定并发 12 应按引擎调整 | ✅ 合理 | `content-page-translation.js:24 CONCURRENCY = 12`。本地 NMT 是同进程串行开销，云端是网络并发，同一个数字不该两边用。 |
| 5.3.2 | 双开关困惑（需原播放器字幕已开） | ✅ 成立 | `content-caption-providers.js:100` 读 `.ytp-subtitles-button[aria-pressed]`；`shared/caption-core.js:309 pickSubtitleTrack()` 只收 `showing`/`hidden`，从不激活 `disabled` 轨。 |
| 5.3.6 | 当前会预译整条轨道 | ✅ 成立 | `content-video-captions.js:465 ensureTrackTranslated()` 循环 `pickNextBatch()` 直到全轨译完。本地引擎无所谓，云端引擎是实打实的浪费。 |
| 5.3.7 | `translateCues()` 按下标回填，需补条数校验 | ⚠️ **代码事实成立，但不是线上 bug；残留风险与它说的不是同一个** | `content-video-captions.js:408` 确实 `translations.forEach((t, index) => cues[index])`。但**两条引擎路径都已保证条数相等**：AI 路径 `background/background.js:1887` 发现分隔符段数 ≠ 输入数就整批回退编号法（注释详述了"错开一位"事故）；内置路径 `content-translation-engine.js:641-661` 逐条 push，天然等长。真正残留的是另一件事：若将来出现短数组，`:410 if (!cue) return` 只挡溢出，**尾部 cue 会永久留在 `pendingKeys` 里**（`isSegmentTranslatable` 见 pending 即跳过），既不重试也不显示。定级 P2 加固，不是 P0。 |
| 6.x | manifest 无 `commands`、无 `all_frames` | ✅ 成立 | `manifest.json` 两者皆无。 |
| 7 | 站点规则做成声明式数据 + schema + 版本，**不要下发 JS** | ✅ 成立且重要 | 与 Chrome remote-hosted-code 政策一致；我方 R4 只说了"规则表是纯数据"，没写 schema/版本/回滚。 |

---

## 2. 评审补上的三个真窟窿（我方文档原先没有）

### 2.1 内容身份 —— P0 结构性缺陷

`.ai-translator-translated` 是**节点身份**，虚拟列表复用的正是节点。X / Reddit 是本轮的两个核心站，恰好都是虚拟列表。

**改法**：源元素上再记一份内容身份。

```
data-bt-block   = 稳定块 ID（站点适配器给，如推文 ID；无适配器时按 DOM 路径生成）
data-bt-hash    = 规范化正文的短 hash
```

跳过条件从 `classList.contains('ai-translator-translated')` 改为
`hasAttribute('data-bt-hash') && data-bt-hash === hash(当前正文)`。
hash 不匹配 = 节点被复用 = 当作新块，先清掉旧译文再翻。

### 2.2 会话代次 —— 迟到响应污染

每次"路由变化 / 目标语言变化 / 引擎变化 / 用户恢复原文"都 `sessionVersion++`。
请求带 `{sessionVersion, blockId, textHash}`，响应回来三件事全过才插入：
节点仍 `isConnected`、`textHash` 未变、`sessionVersion` 相等。

这条同时修掉评审 5.3.5 的字幕跨视频污染 —— 用同一个机制，不要给字幕另写一套。

### 2.3 缓存键与规则优先级

- 缓存键补齐：`normalizedText + sourceLang + targetLang + engine + modelId + promptVersion + glossaryVersion`。
  我原来只有 `text + targetLang + engine + modelId`，**改提示词或换术语库后旧缓存会继续供应错译**。
- 规则优先级写死四级：**当前页明确选择 > 站点/路径规则 > 语言规则 > 全局默认**。
  我的 `decide()` 原来只是"三态查表"，没定义冲突时谁赢。

---

## 3. 评审暴露的一个矛盾（我 PRD 自己的）

FR-9 写着"**默认配置下，自动翻译全程不调用任何计费接口**"。

严格按字面：成立 —— 默认没配 Key，`canFallBackToAI()` 为假，回退不会发生。

但把"自动翻译默认开"和"静默回退"叠在一起，就有了一个手动模式下不存在的新情况：

> 用户配过 BYOK Key（为了偶尔用 AI 重译），之后在一个 `http://` 站点或不支持的语言对上打开自动翻译 ——
> 整页内容会**在零点击的情况下**发往他自己的付费接口，界面上没有任何痕迹。

手动模式下这不算问题（是用户点的翻译）。自动模式下它就是"我没动手却在花钱"。

**FR-9 增补一条**：自动模式下的引擎回退**必须显式**。设置里给"仅本地 / 允许回退到我的接口"二选一，默认**仅本地**；发生回退时悬浮球状态点变色，点开说明"本地不可用，本次用了你配置的接口"。这条同时落实评审 3.4。

---

## 4. 不采纳 / 收窄的部分

| 评审建议 | 处置 | 理由 |
| --- | --- | --- |
| §6.2 popup 九行信息架构 | **收窄到四行** | 与"交互越简单越好"直接冲突。保留：①顶部当前站点＋引擎真实状态 ②主按钮 翻译/恢复 ③本站自动翻译开关 ④暂停本页。双语/仅译文、目标语言、更多入口留在设置页与悬浮球菜单 —— popup 不该是第二个设置页。 |
| §6.1 四步首次引导 | **只取第 2 步** | 不做向导。但"首次语言包准备"确实需要可见 —— 做成首次翻译时的一条非阻塞状态条（本来就有 `NEEDS_DOWNLOAD` 与预取逻辑，`content-translation-engine.js:724+`），不是一个引导页。 |
| §4.2 一次性建八个模块 | **M1 只建四个** | `site-policy` / `content-discovery` / `translation-session` / `translation-cache`。渲染与调度先留在既有引擎里改。评审自己写了"以功能风险决定重构范围"，八个模块一次上违反这句。 |
| §8 "4–8 周"容量估算 | **不进 PRD** | 评审已自标"估算不是承诺"。 |
| §5.3.9 字幕侧栏 / §2 ePub / ASR / 会议 | **维持非目标** | 与我方 §2.2 一致，评审 §10 也建议暂缓。 |
| §5.3.7 字幕条数校验 | **降级 P2** | 见 §1 核验：上游两条路径已保证等长，真实残留风险是"尾部 cue 卡死在 pending"，按加固处理。 |

---

## 5. 双方独立收敛的结论（置信度提高，直接定案）

| 议题 | 评审 | 我方 | 定案 |
| --- | --- | --- | --- |
| 悬浮球点击语义 | §6.3 单击翻译/恢复 + 小箭头开菜单 | D1 选项 (a) | **定案取 (a)**：单击即译/恢复，箭头开菜单。当前 `content-float-ball.js:324` 单击开菜单 = 翻译要两次点击。 |
| 默认不把所有站点自动翻译打开 | §6.1 末 | UX §2.9 | 定案：新装全部 `ask`，用户自己开。 |
| 站点规则做成带 schema/版本的声明式数据 | §7 | R4 | 定案，补 schema 与回滚到 FR-1。 |
| 三层验证（策略单测 / fixture / 真站冒烟） | §9 | PRD §4.1 | 定案，评审的场景表并入验收清单。 |
| 术语库先打通客户端（`/api/glossaries` 已支持扩展凭证） | §7 | 未写 | 采纳为 P2，但先验本地 NMT 能否遵循术语 —— 不能默认套给所有引擎。 |

---

## 6. 合并后的路线：M0 插队

原 M1–M4 不变，前面插一个 M0。M0 的存在理由很简单：**"自动翻译默认开"的前提是"默认就能翻出来"**，而现在新用户拿到的是一句假报错。

| 工作包 | 落点 | 出口标准 |
| --- | --- | --- |
| **M0-a** `checkStatus()` 改成按当前引擎真实可用性算状态 | `popup/popup.js:485` | 免 Key 默认不报配置错误；四态：本地就绪 / 准备语言包 / 环境不支持（给云端与 BYOK 出路）/ BYOK 缺配置 |
| **M0-b** `uiLanguage` 与 `targetLang` 解耦 | `i18n/messages.js:2873` + 5 处调用 | 改翻译目标语言不改界面语言；新增 `writingTargetLanguage`（输入框方向与阅读方向分开） |
| **M0-c** `minimum_chrome_version` 与默认引擎对齐 | `manifest.json:7` | 116→138，或保留 116 但安装后按探测结果把默认引擎降级并明说。**二选一必须定** |
| **M0-d** 引擎回退显式化 | `content-translation-engine.js:684-709` + 设置页 | "仅本地 / 允许回退"二选一，默认仅本地；回退时有可见痕迹 |
| **M0-e** `autoDetect` 改名"跳过已是目标语言的内容" | `options` + `content-bootstrap.js` 默认值三处 | 与新的自动翻译开关在语义上不再打架 |

出口：**Chrome 138 全新安装、不登录、不填 Key，打开一个英文页面能出译文，popup 不报错。**

M1 增补：内容身份（§2.1）+ 会话代次（§2.2）+ 缓存键补齐（§2.3）+ 并发按引擎取值。
M2 增补：FR-9 的显式回退条款（§3）。
M3 增补：字幕滑动窗口预译（评审 5.3.6）+ 字幕失败态分类（5.3.3）+ 尾部 cue 卡死加固（5.3.7）。

---

## 7. 一句话结论

评审和我方在**做什么**上高度一致（自动化策略 / 动态生命周期 / 站点适配 / 入口收敛），分歧只在**怎么呈现**（它倾向信息完备的控制面板，我倾向少到不用学）。它真正的增量是三处：**popup 假报错**、**UI 语言耦合** 这两个我漏掉的 P0 现存缺陷，以及 **虚拟列表打穿了我的幂等假设** 这一处设计洞。这三条已并入 PRD。
