# P1-C 术语表：按站点 / 语言的词表、AI 领域预设与页面上下文、CSV 导入导出

- 日期：2026-09-25；修订 2026-09-27（重新对锚到 ff63adc，见下一节）；修订 2026-09-28（C1 评审回合 1 的文本勘误，见「修订 2026-09-28（C1 评审回合 1）」；C2 评审回合 1 的文本勘误，见「修订 2026-09-28（C2 评审回合 1）」）
- 基线：`origin/main@ff63adc`（manifest 1.4.0；P0 六项、P1-A #107、P1-B #115 全部合入；e6b003b = #114 Reddit credit-bar，a99435d = #113）；分支 `feat/p1-c-glossary`（= `ff63adc` + 本文）
- 行号口径：全部是 `ff63adc` 的行号；「B§x」= P1-B 设计 `docs/plans/2026-09-24-p1-b-site-rules.md` 的小节（不再引 B 的原始行号，那些已经漂移）
- 所属：P1 功能对标回合（台账 D-291）；D-302 的 P1-C 部分和 D-303 的修订在这里定稿，本设计的自决登记为 D-306；D-314 的 P1-C 来信各点已折进 §3.9 / §5 / §6.3 / §9 / §12
- 交付：一个 PR `feat/p1-c-glossary`，由四批串行拼装——C1 数据层、生效点与缓存，C2 设置页与 CSV，C3 领域预设与页面上下文，C4 选区卡片「加入术语表」。P1-B（B1+B2）已合入，C1 直接用 `SyncCollection`、`ctx.syncMirrors`、`StorageWriter` 与 `SiteRules.hostMatches`

## 修订 2026-09-28（C2 评审回合 1：文本与实现对齐）

只改文字，不改设计。C2 评审（`review-c2-source`、`review-c2-journeys`，修复回合 D-370 第 9 项）指出设计与 C2 实现不一的五处，按实现改文：

| # | 位置 | 旧 | 新 | 为什么 |
|---|---|---|---|---|
| 勘-6 | §4.2 `preview(result)` | `transferPreviewGlossary`：「术语表：新增 {added} 条，替换 {replaced} 条」 | 「术语表：将新增 {added} 条、替换 {replaced} 条。」 | 与卡片自己的预览（§4.1 导入 CSV 第 2 步 `glossaryImportPreview`）同一句式；词典与 C-J4 第 5 步按这一句断言 |
| 勘-7 | §8 `glossaryUsage` | 占位符 `{kib}` `{count}` | 占位符 `{used}` `{total}` `{count}` `{max}`：「已用 {used} KiB / {total} KiB · {count} / {max} 条」 | §4.1 头部的用量句本来就有四个数；上限从 `Glossary.LIMITS` 取，不写死在词典里 |
| 勘-8 | §9 新文件表 | 无 | 加 `options/css/glossary.css`（C2，`options.html` :17 的 `<link>`） | 卡片的列表、小标签和表单样式单独成文件，不往共用样式表里堆；没有新的 `!important` |
| 勘-9 | §4.1 位置与加载 | `options.html` 插入整张 `<section id="glossaryCard">` 卡片 | `options.html` 只留空的挂载点 `<section class="settings-card settings-card-full" id="glossaryCard"></section>`；卡片里面的标记是 `options/options-glossary.js` 的常量 `GLOSSARY_CARD_MARKUP`，加载时填进去 | `options.html` 要守住 1000 行 |
| 勘-10 | §4.2（整份导入导出卡片） | 未提 | 同一原因，`#transferCard` 里面的标记搬进 `options/options-transfer.js` 的常量模板 `TRANSFER_CARD_MARKUP`，`options.html` 只留挂载点；标记内容逐字不变（去空白与注释后比对相等，证据 `evidence/p1-c/review-c2-journeys/transfer-markup-compare.txt`） | 同上；只是搬家，没有改标记 |

## 修订 2026-09-28（C1 评审回合 1：文本与实现对齐）

只改文字，不改设计。C1 评审（`review-c1-source.md` N-2 / N-7 / N-12，`review-c1-journeys.md` N6、N8 与「登记」第 1 条）指出的五处设计内部不一或与实现不一，按实现改文：

| # | 位置 | 旧 | 新 | 为什么 |
|---|---|---|---|---|
| 勘-1 | §6.1 C-J1 | GLOSSARY 块含 `{"s":"attention","t":"注意力"}` | 块里是 §3.5 的行式 `- "attention" → "注意力"` | §3.5 的 JSON 只是消息字段 `addenda.glossary` 的形状，给模型看的块一直是行式；代码与 spec 都按行式 |
| 勘-2 | §2.3、§2.4 | SW 侧写 `GLOSSARY_WRITE: Glossary.writer` | `Glossary` 导出 `applyWrite(message, sender)`（SW 分派调它）与 `request(kind, payload)`（页面侧发消息），都来自 `StorageWriter.create`；`STORAGE_WRITERS` 的行是 `GLOSSARY_WRITE: () => globalThis.Glossary` | 与 `CustomRules` / `SiteRules` / `AutoStats` 同形；不加 `writer` 别名（删除优于兼容） |
| 勘-3 | §9 分批 | C2 独占 `options.html`、C3 独占 `batch.js`；「每批一个本地提交」 | `options.html` 的装载清单（§9 加载表）与 `batch.js` 的 `splitSafe` 迁移（§3.9）在 C1；C2 只加卡片那一段。`onboarding/onboarding.html` 也装引擎族，同批补上装载清单。每批按逻辑拆成若干本地提交，PR 合入时 squash | §9 加载表、§3.9 迁移表本来就要求 C1 改这两个文件；一批一个提交的写法与 C1 的实际提交序列不符 |
| 勘-4 | §6.1 C-J5 | 步骤 1 翻完后「不刷新」加词条 | 步骤 1 与步骤 2 之间多一次刷新（`test/e2e/glossary-cache.spec.js`），加词条之后仍不刷新 | 步骤 3 要悬停同一段，而悬停不接已整页翻过的块（`content/hover/blocks.js` 的 `isValidBlock` 认 `ai-translator-translated`）；多出的这次刷新在加词条之前，generation 递增照样在同一次加载里看得到 |
| 勘-5 | §6「测试台要补的三样」的等待判据 | 只写了「内容脚本就绪」一种（`data-ai-translator-style`） | 两种判据并列：内容脚本就绪用于点击类断言；持久缓存落盘（`countPersistentCacheKeys` 数 `tc:` 键）用于「刷新后不再请求」类断言 | C1 的 C-J5 / C-J8 把固定的 `waitForTimeout` 换成了轮询 `tc:` 键（`review-c1-journeys.md` N6），设计只记了前一种 |

## 修订 2026-09-27（重新对锚到 ff63adc）

原文按 cd0522b 写，P1-B（#115）和 #113/#114 合入后行号、几个接口名和两处假设都变了。逐条改动如下；行号只写变化了的，全文其余行号已同步。

### 改了什么

| # | 位置 | 旧 | 新 | 为什么 |
|---|---|---|---|---|
| 修-1 | 头部、§1 | 基线 cd0522b | ff63adc；所有 file:line 重对；B 的原始行号（B :142/:222/:386/:388/:392/:594）改成 B§ 小节号 | P1-B 合入后行号整体漂移；B 文档自身也在 #115 里改过 |
| 修-2 | §2.5、§3.1、§12-4 | `GLOSSARY_FOR_HOST` 进 B1 的分派表（`background.js` :138），SW 用 `sender.tab.url` | B1 没有建分派表：`CUSTOM_RULES_FOR_HOST` 住在自己的模块 `background/custom-rules-host.js`（:15-28，自己挂 `onMessage`，主机取 `sender.url`，`background.js` :51 import 它）。C1 照样建 `background/glossary-host.js`；`GLOSSARY_WRITE` 进 `STORAGE_WRITERS` 表（`background.js` :78-82）和 `case` 列表（:153-158） | 和已合入的写法一致；一个消息一个模块，不往 `background.js` 的 switch 里堆 |
| 修-3 | §2.4、§5 | `scope: 'site'` 的 `h` 按 `sender.tab.url` 算 | 保持 `sender.tab.url`（顶层页面的地址）；`GLOSSARY_FOR_HOST` 改按 `sender.url`（与 `custom-rules-host.js` :19 一致，只有顶层帧请求，两者相等） | 见自决 修-A |
| 修-4 | §2.5、§3.1 | 子帧也把 `glossary:` 前缀登记进 `ctx.syncMirrors`，登记项什么也不做 | 删掉。`routeSyncMirrors`（`content-bootstrap.js` :150-166）对没有镜像认领的键只是并入 `rest`（:157-160），不告警；子帧不登记就是「没有」 | 一个什么也不做的登记是兼容层（删除优于兼容） |
| 修-5 | §4.2、§12-4 | 「B2 和 C2 谁先合入，谁建 `collectionSection` / `COLLECTION_REFUSALS` / `TRANSFER_ERROR_KEYS`」 | B2 已合入：`collectionSection` :143、`COLLECTION_REFUSALS` :122-127（:120 的注释已给术语表留位）、真名是 `TRANSFER_REASON_KEYS` :130-134、`TRANSFER_SECTIONS` :194、`TRANSFER_SECTION_NAMES` :216-220；C2 只加行 | 名字和先后关系都定了 |
| 修-6 | §4.2 | `validate(raw)` 调 `previewGlossaryImport(raw)` | 照 `customRulesSection`（`options-transfer.js` :168-192）的缝：`validate` 直接调卡片文件导出的全局预览函数（那边是 `previewCustomRulesImport(file)` :75，收解析后的对象）；术语表的小节值是 CSV 文本，所以 `previewGlossaryImport(text)` 收文本，`apply` 传 `{csv: value}` | 同一条缝、同一个预览函数，只是载荷形状随格式 |
| 修-7 | §4.3、§12-4 | 带 `domain` 的规则写 `v: 2`（引 B :594） | 保留 v2 写法（B§2.2 的「最低版本」规则），但要改代码：`shared/custom-rules.js` `VERSION = 1` :33、`normalizeRule` :151 对 `v !== 1` 抛 `customRuleInvalid`、:164 只写 `{v: VERSION, match}`、`decode` :187 对 `v !== 1` 返回 null；单测 `custom-rules.test.mjs` :89（`{...ok, v: 2}` 应拒）和 :199-205（`v: 2` 被跳过）钉的是相反的行为，要翻 | 见「不再成立」第 1 条 |
| 修-8 | §4.3 | 规则编辑表单「加领域下拉」 | 具体到 `options-custom-rules.js`：`CUSTOM_RULE_FIELD_LABELS` :41-47 加 `['domain', 'customRuleDomain']`（列表行 `customRuleRow` :166 按它画标签，N-12）；`engineField` :271-298 是下拉字段的现成写法，`domainField` 照抄；`openCustomRuleEditor` :300 挂进表单、`readEditor` :377-380 与 `saveCustomRule` :420-426（`validateRule`）收 `domain` | 表单结构已经存在，按它落位 |
| 修-9 | §2.7、§3.9、§12-1 | `debrisPattern(markupElements)` 返回正则；insert.js 三处 :18/:55/:104 | #114 把 `markupDebrisRe` 改成了函数 `markupDebrisScrubber(markupElements) → (text) => text`（`insert.js` :24-47，替换回调里做编号拆分，:43 是新字面量）。改名 `debrisScrubber`，语义原样保住（§2.7）；insert.js 的四处是 :43/:75/:124/:146 | D-314「撞车」一条：保住 credit-bar 的语义并把新字面量计入 |
| 修-10 | §1 末行、§3.9 | 「8 处 `{{` 正则」 | 副本清单收齐到 §3.9 表所列的全部副本（八个文件、十九个位置），含 collect.js 的 `MARKUP_MARKER_RE` :33 与 `stripPlaceholders` :44-47、content-language.js :113 的兜底字面量、引擎 `PLACEHOLDER_RE` :225、insert.js 的锚定式 :124 | D-314 第一点 |
| 修-11 | §3.9、§6.3 | `markup-marker-regex.test.mjs` 由扫描单测「取代」 | 换成 `test/unit/text-markers.test.mjs`：保留 `i` 标志那条断言（改断 `TextMarkers.markerPattern().flags` 含 `g` 与 `i`），残片清理的语义用例（自有标签 / 编号拆分 1111 = 11·11、1213 = 12·13 / 拆不开不动 / 5000 位数字线性）搬过来，直接 `import` 新模块，不再 `new Function(source)`；加交错调用用例 | D-314 第二、三点 |
| 修-12 | §3.9、§6.3、§9 | 加载顺序「写法同 `LOAD_LISTS`/`LOAD_ORDER`」 | `site-rules.test.mjs` 的顺序用例（:824-850）只读 manifest 和 `LOAD_LISTS`（:787-793）的五个文件，不读 `test/e2e/helpers.js`。新用例照 `translation-display.test.mjs` :324 的先例读 helpers.js 源码里的 `PAGE_TRANSLATION_MODULES`，断言 `shared/text-markers.js` 在两处都排在 `content/content-language.js`（manifest :118，helpers :83）之前 | D-314 第四点 |
| 修-13 | §5、§6.1 | C-J7 只说「J-D9 的几何断言照样通过」 | 按钮点击后改字（加入 → 已加入），这次点击进 J-D9 的点击清单（`test/e2e/selection-card.spec.js` :614） | D-314 第五点 |
| 修-14 | §3.4、§3.6、§12-5 | `sendToModel` 包 :672-675；`withGlossary` 接 :538/:561；`wantsBuiltin` :614；catch :564-576 / :652-659 | `requestTranslation` :655-704，唯一出口 :700-703（注释 :695-699）；`handleWithBuiltin` :548，两处调用 :562（单条）/ :585（批量）；批量 catch :588-600（推 `''`，上层保留原文，不是「留原文」）；单条 catch :679-687；`wantsBuiltin` :638；`keepsPlaceholders` :241；丢占位符抛 :392-393；`EngineUnavailableError` :123；`splitForQuota` :268，定长退化分支 :274-278 | 行号漂移；批量 catch 的语义按代码 |
| 修-15 | §3.5 | 计数替换引擎 :472、ai-translate :159/:173/:216；wiring 断言 :386 | 引擎 :491；ai-translate :160/:174/:217；`auto-translate-wiring.test.mjs` :388 | 行号漂移 |
| 修-16 | §3.8 | 子帧 :218 覆盖；`computeDirective` :45 / `sameDirective` :54 / `refreshDirective` :74 / `setupTopFrame` :158；`applyDirective` :164；缓存文件 :121 / child :164 | child.js :226；top.js :44 / :54 / :75 / :159；child.js :167；manifest :124 / :168 | 行号漂移 |
| 修-17 | §4.1、§4.3、§9 | `options.html` :749 / :762-789 / :791 / :911 / :939 / :940；`options.js` :286 / :582 / :720-725 `applyPresetPrompt` | :789（`<!-- Custom Prompt -->`）/ :807-822（`#presetStandard` `#presetLiteral` `#presetCreative`）/ :832-834 / :954 / :984 / :985；`options.js` :286 / :550（`IMMEDIATE_SAVE_FIELDS`）/ :121（`PROMPT_PRESETS`，没有叫 `applyPresetPrompt` 的函数） | 行号漂移；改用真名 |
| 修-18 | §4.3 | 上下文入口表引 `batch.js` :396/:541/:605 三处 | 三处都经 `requestBatch`（:38-39，`(ctx.requestTranslationCached \|\| ctx.requestTranslation)(message)`）。前后文在这三处各自算（只有它们知道这一批是哪几段），塞进消息后走同一个 `requestBatch` | 说清一处出口、三处取材 |
| 修-19 | §6 | `stubBuiltinTranslator` :516，`__builtinCalls` :519/:523；`content-input-dialog.js` :266；`content-popup.js` :617 | :529，:532/:536；:274；`translateText` 定义 :581、导出 :676 | 行号漂移 |
| 修-20 | §1、§3.9 | manifest :115/:119/:121/:164；`sync-collection` :106 / `custom-rules` :107 | :118/:122/:124/:168；:106/:107 未变 | 行号漂移 |

### 自决（本次修订新增；台账 D-306 之外，交主控回填编号）

| # | 裁定 | 依据 |
|---|---|---|
| 修-A | **两种主机来源**：`GLOSSARY_FOR_HOST` 按 `sender.url`（`custom-rules-host.js` :19 的先例；只有顶层帧发它，`sender.url` 就是顶层地址）；`GLOSSARY_WRITE` 的 `put` 带 `scope: 'site'` 时按 `sender.tab.url`（C4 的卡片可以在子帧里，§0.1-4 要的是顶层页面的主机；`sender.tab.url` 是那个 tab 的顶层地址） | 最小改动：读的一半照抄已合入的先例，写的一半按语义取顶层 |
| 修-B | **`CustomRules.VERSION` 改成集合 `{1, 2}`，`normalizeRule` 只在有 `domain` 时写 `v: 2`，`decode` 两版都收，`v > 2` 仍跳过** | B§2.2「最低版本」规则的字面执行；单测 :89 改成 `v: 3` 拒、:205 改成 `v: 3` 跳过，并加 `v: 2` 带 `domain` 合法、`v: 2` 不带 `domain` 拒（无效字段组合）两条 |
| 修-C | **`debrisScrubber` 是函数不是正则**，签名 `(markupElements) => (text) => text`，与 #114 的 `markupDebrisScrubber` 同形，insert.js :404 的调用点只改名 | 残片清理要按块的标签集拆编号，正则表达不了（:22-24 的注释说了指数回溯） |
| 修-D | **`TextMarkers` 用双模经典脚本**（同 `shared/custom-rules.js` 的写法），单测直接 `import` | 让 `new Function(source)` 那套装载消失；引擎测试台（`engine-harness.mjs` :95-100）也能直接 import |

### 不再成立的假设（P1-B / #114 合入后）

1. **规则 v2 的升级路径没有现成的门**：`custom-rules.js` :151/:164/:187 把 `v` 钉死在 1，B§2.2 只写了规矩没写代码。→ 修-B；改动都在 `shared/custom-rules.js` 一个文件里，`pick`（:218）挑出胜者后 `custom-rule.js` 的 `current()`（:55-70）要把 `domain` 放进冻结对象，`signatureOf`（:78-83）不加它（§0.1-17：领域不进重启签名），新的 `onProfileChange` 签名加它。
2. **没有 SW 分派表**：见修-2。`custom-rules-host.js` 的模式是「一个模块、一个消息类型、别的消息不回话也不 `return true`」（:8-10 的注释），`glossary-host.js` 照抄。
3. **规则编辑表单有位置**：字段标签表 :41-47 和 `engineField` :271-298 给 `domain` 留好了模式（修-8）；`readEditor` :380 的 `if (editor.engine.value)` 写法照搬到 `domain`。
4. **sync 额度**：`custom-rules.js` `LIMITS` :38-40 是 24 KiB / 50 条，与 B§2.1 的表一致；词表 32 KiB / 300 条仍装得下。代码里没有跨集合的总量检查，每个集合各自 `assertFits`（`sync-collection.js` :156），总和 ≤ 100 KiB 靠这张表；本设计不加总量检查。
5. **缓存文件自己的 `storage.onChanged`（:50-52）还在**，`routeSyncMirrors` 已经有了：§3.8 删监听、改由 bootstrap 通知的方案照旧成立。
6. **`content-language.js` :106-110 的注释**说标记定义在 `content-page-translation.js`（已不存在的文件）并要求兜底逐字一致：整段注释随兜底一起删。

## 0. 结论

今天用户没有办法告诉翻译「这个词这样译」或「这个词别译」。唯一的抓手是 `customPrompt`（`background/settings.js` :67，设置页 `options/options.html` :832-834）：一段自由文本，只对 AI 生效，所有网站、所有目标语言一样，写进去的词条还会和 `background/prompts.js` 里「术语保留原文」的规则（:28/:38/:56）打架。内置引擎（Chrome Translator API）完全不看它。沉浸式翻译在这块给的是：术语表（设译法或保留原文，可限定站点）、AI 领域/专家预设、把页面标题和前后文附给模型，以及术语表的导入导出。

这一轮：

- **入口**：设置页新卡片「术语表」（增删改、搜索、CSV 导入导出、用量条，C2）；选区卡片操作行加「加入术语表」（C4）；领域和页面上下文放进「自定义提示词」卡片（C3）
- **存储**：`chrome.storage.sync`，一条一个键 `glossary:<id>`，建在 P1-B 的 `SyncCollection` 上，合计 ≤ 32 KiB、≤ 300 条
- **生效点**：顶层帧的 `ctx.requestTranslation`，所有翻译请求都经过它（B§0.1-12）。AI 请求带上附加说明（词表、领域、上下文），内置引擎用占位符保护命中的词条

| # | 能力 | 边界（刻意不做的） |
|---|---|---|
| 1 | 词条：原文 → 译文，或「保留原文」；可选区分大小写 | 不做正则、通配、词形变化（run / ran / running 要分别写）；原文 ≤ 80 字，译文 ≤ 160 字 |
| 2 | 作用域：所有网站或某个站点（含子域）× 所有目标语言或某一门 | 站点按顶层页面算，iframe 里的文字跟着顶层走；不做路径级作用域 |
| 3 | AI：词表 + 领域 + 可选的页面上下文写进系统提示词 | 每次请求最多带 60 条（按命中次数挑，超出就拆请求）；已经显示的译文不重译 |
| 4 | 内置引擎：命中的词条换成占位符，译完还原 | 占位符被引擎弄丢，就不带词表把原文再译一次，还丢才算这一段失败；领域和上下文不给内置引擎 |
| 5 | 领域预设：通用（默认）、科技、学术、法律、医学、金融、游戏、小说、新闻；站点规则可覆盖（C3，规则 v2 字段 `domain`） | 只影响 AI；不做自定义领域 |
| 6 | 页面上下文：标题 + 段落前后文（默认关） | 只给 AI；输入框翻译和设置页永远不带；上下文字数计入每日 AI 额度 |
| 7 | CSV 导入导出，外加设置整份导入导出里的「术语表」一节 | 导入全有或全无；不做 Excel / TSV；不做云端词库 |

### 0.1 自决（台账 D-306 已登记，此处给依据）

| # | 裁定 | 依据 |
|---|---|---|
| 1 | **一条一个键，id 只在键里**（`glossary:` + 8 位 base36） | 同 B§0.1-1 与 B 的 (e)：整张表放一个键会撞 8 KiB 单项上限；id 写进值里，300 条要多花约 4.7 KiB |
| 2 | **合计 ≤ 32 KiB、≤ 300 条，单条 ≤ 1 KiB（按存进去的形状计）；超额拒绝，不截断** | B§2.1 的额度表给词表留了 32 KiB / 300 项；键 17 B + 值平均约 92 B，300 条约 32 KiB；检查只有一份 `assertFits`（B§0.1-2） |
| 3 | **写只发生在 SW 的单写者队列里**（`GLOSSARY_WRITE`：put / remove / import） | 同 B§0.1-3：设置页和选区卡片可能同时写；`SyncCollection.write(compute)`（`shared/sync-collection.js` :215）在队列里读、算、写 |
| 4 | **站点作用域 = 顶层页面的 host，后缀匹配** | 用户在 A 站看到的嵌入内容，在用户眼里就是 A 站；匹配语义用 `SiteRules.hostMatches`（`shared/site-rules.js` :84，导出 :610）；iframe 的请求本来就在顶层执行（B§0.1-12） |
| 5 | **优先级：站点 > 全局，指定语言 > 所有语言，区分大小写 > 不区分，新 > 旧** | 越具体越赢；同样具体时新写的赢，符合「我刚改过」的预期 |
| 6 | **原文含大写字母时默认区分大小写** | 「Transformer」这类专名不在句首也带大写；全小写的「attention」不区分，才能命中句首的「Attention」 |
| 7 | **精确匹配，最左最长，不重叠；拉丁 / 西里尔 / 希腊字母按词边界，其余按子串** | 中日文没有词边界；不用正则内联修饰符（Chrome 125 才有，最低版本是 116）；算法见 §3.2 |
| 8 | **只在文字片段里匹配，不跨占位符和标记** | 公式占位符和 `<b0>` 这类标记是结构，往里替换会弄坏还原；跨标记的词条记为已知限制（§7） |
| 9 | **唯一生效点：顶层帧的 `ctx.requestTranslation`** | 所有入口都经过它（CLAUDE.md「Translation Engine」）；子帧的请求本来就转发到顶层（`content/frames/child.js` :226）；SW 翻译时不读词表 |
| 10 | **AI 用结构化的附加说明，不改用户的 `customPrompt`** | 附加说明经 SW 路由校验后拼进系统提示词；用户的自由文本原样不动 |
| 11 | **词表压过「术语保留原文」规则** | `prompts.js` :28/:38/:56 要模型保留术语原文，和「attention → 注意力」冲突；附加说明块第一行写明它优先 |
| 12 | **一次请求最多带 60 条，超出就拆请求；每份各自计费，任一份失败整批失败** | 提示词长度和成本；已花的额度不退（§7） |
| 13 | **内置引擎：占位符保护，丢了就不带词表重译一次** | Translator API 是 NMT，会拆、会译、会丢 `{{n}}`（`keepsPlaceholders` :241 已有的判断）；重译不是回落，引擎戳和钉住的引擎都不变 |
| 14 | **缓存键加第八个因子 `addenda`，值是内容戳** | 改一条词条只让含它的文字失效；戳只含这段文字命中的词条、领域 id、上下文开关（§3.7） |
| 15 | **子帧的缓存查询也经顶层**（信封加 `via`） | 缓存和词表都在顶层；子帧自己查缓存会用错的戳 |
| 16 | **改词表不重译已显示的译文，新请求立刻用新词表** | 同 B§3.6「已有译文不重译」；悬停和字幕的本地缓存靠 `ctx.translationProfile.generation()` 失效 |
| 17 | **领域只影响 AI，给模型的是英文句子；不进重启签名** | 内置引擎没有提示词；改领域不该让整页重跑（B§3.6 的重启签名只管会改变「译不译」的字段） |
| 18 | **页面上下文默认关，只给 AI，计入每日额度，输入框永远不带** | 把页面其他文字发给第三方要用户明确打开；输入框里是用户自己写的东西 |
| 19 | **CSV：五列或两列，RFC 4180，导出带 BOM；导入全有或全无，先预览，不弹确认** | Excel 打开 UTF-8 要 BOM；和 B§0.1-16/19 同一套规矩（预览就是确认） |
| 20 | **设置整份导入导出加「术语表」一节**，走 P0-F 的 section 契约 | B§12.4：`collectionSection(spec)`（`options/options-transfer.js` :143），三份集合的导入是同一个动词 |
| 21 | **选区卡片的按钮放在「换引擎」和「复制」之间，是否显示在译完后一次决定** | P0 的约定；不先藏后显，操作行不回流（J-D9） |
| 22 | **占位符与标记的语法收进一个模块 `shared/text-markers.js`** | 今天 `{{n}}` 和 `<a1>` 的正则散在八个文件的十九个位置（§3.9）；词表要在同一语法上再加占位符，第十七处就是漂移的开始 |

## 1. 现状（file:line）

| 位置 | 现状 | 本轮 |
|---|---|---|
| `background/settings.js` :67，`options/options.html` :789-834 | `customPrompt` 是唯一抓手：自由文本，只给 AI，全站全语言一样 | 不动；C3 在同一张卡片里加领域和页面上下文 |
| `background/prompts.js` :28/:38/:56，:77-88 | 三种模板都要求术语保留原文；`buildPrompt(template, targetLangName, variables, extraRules, options)` 把 `MATH_PLACEHOLDER_RULE` 放在最后，两个 `return` 在 :85 和 :87 | C1：附加说明块插在模板和数学规则之间，所有分支（含单词翻译）一样 |
| `background/background.js` :109/:115/:121，:321/:340/:359 | 三种翻译消息 `TRANSLATE` / `TRANSLATE_BATCH` / `TRANSLATE_BATCH_FAST`；处理函数 `handleTranslate` / `handleBatchTranslate` / `handleBatchTranslateFast` 只收文字和目标语言 | C1：尾参 `addenda`，处理函数先校验再计字数 |
| 同上 :78-82，:153-158；`background/custom-rules-host.js` :15-28，`background.js` :51 | `STORAGE_WRITERS` 表 + 三个 `case` 分派给 `applyWrite`；`CUSTOM_RULES_FOR_HOST` 在自己的模块里挂 `onMessage`，主机取 `sender.url` | C1：`GLOSSARY_WRITE` 进表和 `case`；`GLOSSARY_FOR_HOST` 建 `background/glossary-host.js`（修-2） |
| `background/ai-translate.js` :90/:123/:159/:172/:216/:272 | 五个翻译函数与 `parseNumberedResponse`；计字数在 :160/:174/:217（`globalThis.AutoStats.textsChars`） | C1：`addenda` 往下传；计数换成 `AutoStats.sentChars(source, addenda)`，C3 起把上下文算进去 |
| `content/content-translation-engine.js` :655-704 | `ctx.requestTranslation`；唯一出口 `sendMessage` :702，前面是 `refuseAutoAiSpend`（定义 :487，调用 :700） | C1：这里是生效点；`sendToModel` 包住额度门和出口；内置分支包 `withGlossary` |
| 同上 :241，:392-393 | `keepsPlaceholders` 只查数学占位符，丢了抛普通 `Error` | C1：换成 `eng.PlaceholderLossError`，数学和词表占位符一起查 |
| `content/content-translation-cache.js` :16，:50-52，:59 | `PROFILE_KEYS` 三个键；只缓存 AI 的 FAST 批；自己监听 `storage.onChanged` | C1：取一次词表快照传给 `requestTranslation`；删掉自己的监听，改由 bootstrap 统一通知 |
| `shared/translation-cache.js` :102/:104/:188 | 七个键因子 `FACTORS`；`buildKey`；`serve` 按批算键 | C1：第八个因子 `addenda`，可以是按文字求值的函数；`buildKey` 遇到函数就抛 |
| `content/frames/child.js` :74-81/:226，`top.js` :126/:149，`background/frame-relay.js` :75-76 | 子帧只转发 `requestTranslation`（`requestTranslationViaTop`），没有缓存层 | C1：信封加 `via`（`cached` / `direct`），子帧也有 `ctx.requestTranslationCached` |
| `content/hover/blocks.js` :75-77，`content/captions/translate.js` :18-20 | 悬停和字幕的本地缓存键不含任何配置 | C1：键里加 `ctx.translationProfile.generation()` |
| `content/content-bootstrap.js` :146，:150-166，:169-187 | `ctx.syncMirrors` 登记表；`routeSyncMirrors` 按前缀分发 sync 增量，剩下的写进 `ctx.settings`（:185-187） | C1：`glossary:` 由镜像认领；剩下的键再通知 `ctx.translationProfile.onSettingsChanged` |
| `content/page/custom-rule.js` :36-43，:55-70，:78-83，:263-273，:275-300 | `request()` 对无回话 / `error` / 缺 `rules` 都抛；`current()` 冻结对象；`signatureOf`；`init()` 建镜像并登记 `ctx.syncMirrors`；shelf `ctx.customRules` 没有 `domain()` / `onProfileChange` | C1 照 `init()` 建词表镜像；C3 加 `domain()` / `onProfileChange` |
| `shared/custom-rules.js` :33，:38-40，:151，:164，:187，:218 | `VERSION = 1`；`LIMITS` 24 KiB / 50；`normalizeRule` 与 `decode` 拒 `v !== 1`；`pick` | C3：v2（修-B） |
| `options/options-transfer.js` :122-127，:130-134，:143，:168-192，:194，:216-220 | `COLLECTION_REFUSALS`、`TRANSFER_REASON_KEYS`、`collectionSection`、`customRulesSection`、`TRANSFER_SECTIONS` 三节、`TRANSFER_SECTION_NAMES` | C2：加「术语表」一节，只加行 |
| `options/options-custom-rules.js` :41-47，:166，:271-298，:300，:377-380，:420-426 | 字段标签表、列表行、`engineField`、编辑器、`readEditor`、`saveCustomRule` | C3：加 `domain`（修-8） |
| `content/content-popup.js` :107-114，:522-526，:535-553，:568 | 操作行：重译 :112、换引擎、复制 :114；`setCardActionsBusy`、`settleCardActions`、`wireCardActions` | C4：加「加入术语表」 |
| `docs/privacy-policy.md` §一 :37，§三 :131-142，§六 :180 | 没有词表和页面上下文 | C1：§三 加一行、§六 加删除说明；C3：§一 加上下文 |
| 八个文件里的十九处占位符 / 标记字面量 | 见 §3.9 的表 | C1：全部改用 `TextMarkers`，守卫单测防复发 |

## 2. 数据与存储

### 2.1 sync 额度（与 B§2.1 同一张表）

| 占用方 | 额度 | 项数 | 依据 |
|---|---|---|---|
| 设置 | ≤ 12 KiB | ≤ 80 | B§2.1 |
| `siteRules` / `siteAskCount` | 各 ≤ 6 KiB | 各 1 | B§2.1 |
| `customRule:*`（P1-B） | ≤ 24 KiB | ≤ 50 | `shared/custom-rules.js` :38-40 |
| **`glossary:*`（本设计）** | **≤ 32 KiB** | **≤ 300** | 键 17 B（`glossary:` 9 B + id 8 B）+ 值平均约 92 B；300 条约 32 KiB |
| P1-D | ≤ 8 KiB | ≤ 20 | B§2.1 |
| 余量 | 12 KiB | ≥ 60 | B§2.1 |

sync 的硬上限：单项 8 KiB、512 项、每分钟 120 次写、每小时 1800 次；一次多键 `set` 算一次写。词表的每一次写（包括导入 300 条）都是一次多键 `set`。代码里没有跨集合的总量门，每个集合各自 `assertFits`（`shared/sync-collection.js` :156）；总和 ≤ 100 KiB 靠这张表约束。

### 2.2 键与值

```js
// 键：'glossary:' + 8 位 base36 id（SyncCollection.newId），id 只在键里
// 值（v 缺省即 1；读到 v > 1 的条目跳过，不报错也不改写）
{
  s: 'attention',        // 原文：1–80 字；NFC、去首尾空白、内部空白压成一个空格
  t: '注意力',            // 译文：≤ 160 字；缺省 = 保留原文
  c: 1,                  // 区分大小写；缺省 = 不区分（原文含大写字母时表单默认勾上）
  h: 'arxiv.org',        // 站点：normalizeHost 之后的主机；缺省 = 所有网站
  l: 'zh-CN',            // 目标语言：TargetLang.SUPPORTED 之一，或 '*'
  u: 1790000000000       // 最后修改时间（ms）；导入的条目取导入那一刻
}
```

- `limits = {itemBytes: 1024, totalBytes: 32768, maxItems: 300}`，按存进去的形状量（键名加不带 id 的值，`SyncCollection.usage` :149）。
- `l` 的合法值在调用时读 `TargetLang.SUPPORTED`，不抄一份（P0-B 以后加语言不用改这里）。
- `hosts(e) = e.h ? [e.h] : []`，交给 `SyncCollection` 的 `forHost`（:116）。

### 2.3 `shared/glossary.js`（`globalThis.Glossary`，双模经典脚本）

建在 `SyncCollection.create({prefix: 'glossary:', decode, hosts, limits, errors})`（`shared/sync-collection.js` :74，返回 `{prefix, newId, validId, collect, forHost, applyChanges, usage, assertFits, merge, write, cached, mirror}`）上，照 `shared/custom-rules.js` :199 的写法；读、写、镜像、增量、额度一律用它给的成员，自己不另写。`decode` 是 `validateEntry` 只查形状的那一半，坏条目和 `v > 1` 的条目返回 `null`（同 `custom-rules.js` :186-187）；`errors = {tooLarge: 'glossaryEntryTooLarge', budgetFull: 'glossaryBudgetFull'}`。另加：

| 成员 | 用在 | 说明 |
|---|---|---|
| `normalizeSource(s)` | 各处 | NFC、去首尾空白、压空白；表单、CSV、匹配器用同一个 |
| `dedupeKey(e)` | SW、设置页 | `${c?'c':'i'}:${c ? s : s.toLowerCase()}\|${h \|\| '*'}\|${l}`，同一个键就是同一条 |
| `validateEntry(e)` | SW、设置页 | 长度、`l`、`h`（`SiteRules.normalizeHost` :69 能算出主机）；不合法抛 `glossaryEntryInvalid` |
| `pick(entries, host, targetLang)` | 内容脚本 | 作用域过滤（`forHost` + `l` 等于目标语言或 `*`），再按 §0.1-5 排出同一原文的胜者 |
| `applyWrite(message, sender)` | SW | `StorageWriter.create(…).applyWrite`：`background.js` 的 `GLOSSARY_WRITE` 分派调它，按 `kind` 跑 §2.4 的三种写 |
| `request(kind, payload)` | 设置页、内容脚本 | `StorageWriter.create({type: 'GLOSSARY_WRITE', writes, errors: 'throw'}).request`（`shared/storage-writer.js`），同 `custom-rules.js` :423 |

加载位置：SW（`background.js` 的 import 表，排在 `shared/sync-collection.js` :20 之后）、内容脚本（manifest，排在 `shared/custom-rules.js` :107 之后）、设置页（`options.html` :945 之后）；popup 不加载。加载时捕获 `SiteRules`、`StorageWriter`、`SyncCollection`、`TargetLang`，缺了就抛。

### 2.4 写：`GLOSSARY_WRITE`（判别字段 `kind`，B§2.4）

| kind | 载荷 | 做什么 | 回话 |
|---|---|---|---|
| `put` | `{entry, scope?}` | 无 id：按 `dedupeKey` 找到就替换、找不到就新增。有 id：替换那一条；改后和另一条撞 `dedupeKey` 就拒绝（`glossaryDuplicate`），存储不动。`scope: 'site'` 时 SW 用 `sender.tab.url` 重新算 `h`（修-A），不信载荷里的 | `{id, replaced}`（卡片提示「已加入」或「已更新已有词条」） |
| `remove` | `{ids}` | 删掉这些键 | `{removed}` |
| `import` | `{csv}` | SW 重新解析、逐行 `validateEntry`、按 `dedupeKey` 合并（同键替换，`u` 取现在），`assertFits` 后一次多键 `set` | `{added, replaced}` |

三种都跑在 `SyncCollection.write(compute)`（:215）里（SW 单写者队列，B§0.1-3）：读 → 算 → `assertFits` → 一次 `set`/`remove`。超额抛 `glossaryEntryTooLarge` / `glossaryBudgetFull`，不截断、不丢行（B§0.1-2）。SW 侧：`background/background.js` 的 `STORAGE_WRITERS`（:78-82）加 `GLOSSARY_WRITE: () => globalThis.Glossary`，`case` 列表（:153-158）加一行，分派调 `applyWrite(message, sender)`，与另外三个写者同形（勘-2；没有 `writer` 成员）。

### 2.5 读

- **SW 翻译时不读词表**。附加说明由顶层帧算好随请求带来（§3.3）。
- **内容脚本**：只有顶层帧建镜像。`content/content-glossary.js` 在 `ctx.init`（`content-bootstrap.js` :249）里调 `Glossary.mirror({request, host: location.hostname})`，写法照 `content/page/custom-rule.js` :263-273；`request()` 照 :36-43：无回话、`reply.error`、缺 `entries` 数组都抛。和规则镜像并行发出，最坏仍是 1.5 s（`READY_CAP_MS`，`sync-collection.js` :33）。
- **`background/glossary-host.js`**：照 `custom-rules-host.js` :15-28——只认 `GLOSSARY_FOR_HOST`，别的消息不回话也不 `return true`；`host = SiteRules.normalizeHost(new URL(sender.url).hostname)`；回 `{entries: Glossary.forHost(await Glossary.cached(), host)}`，失败回 `{error}` 并 `console.error`。`background.js` 在 :51 旁 import 它。
- **子帧**：不建镜像、不登记 `ctx.syncMirrors`（修-4）。子帧的请求在顶层执行（§3.8）。
- **设置页**：`options/options-glossary.js` 用 `collect` 读全部，自己监听 `storage.onChanged`，用 `applyChanges(entries, changes, null)`（:124）跟随，与 `options-custom-rules.js` :531 同一做法。

### 2.6 CSV：`shared/glossary-csv.js`（`globalThis.GlossaryCsv`）

- 列：`source,target,case_sensitive,site,target_lang`；也收两列 `source,target`（其余取缺省）。首行是表头就跳过。
- RFC 4180：逗号、双引号转义、字段内换行；导出写 UTF-8 BOM 和 CRLF，读的时候 BOM 可有可无。
- 导入全有或全无：任何一行不合法就整份拒绝，报 `glossaryImportInvalid`，带第一个坏行的行号（`{row}`）。
- 文件名 `blab-glossary-YYYYMMDD.csv`。
- `parse(text)` → `entries`；`serialize(entries)` → `text`；`previewImport(current, text)` → `{added, replaced}`（先 `parse`，再按 `dedupeKey` 合并一遍，再 `assertFits`）。设置页卡片和整份导入共用这一个预览函数（同 `previewCustomRulesImport`，`options-custom-rules.js` :75 的规矩）。

### 2.7 两个共享的纯模块

**`shared/prompt-addenda.js`（`globalThis.PromptAddenda`）**——SW 和内容脚本都加载：

| 成员 | 说明 |
|---|---|
| `DOMAINS` | `['general','tech','academic','legal','medical','finance','gaming','fiction','news']`，id 与给模型的英文句子一一对应；`general` 不发句子 |
| `LIMITS` | `{entries: 60, before: 300, after: 300, title: 200, source: 80, target: 160}` |
| `validate(addenda)` | 形状 `{glossary: [{s, t?}], domain?, context?: {title?, before?, after?}}`；超限或多出字段就抛，不截断（SW 路由用它把关，§3.5） |

**`shared/text-markers.js`（`globalThis.TextMarkers`，双模经典脚本，修-D）**——占位符与标记语法的唯一写入点。通用语法（占位符、标记的生成与匹配）和逐块的残片清理是两件事，分开导出：

| 成员 | 说明 |
|---|---|
| `placeholder(n)` / `parsePlaceholder(s)` / `placeholderIds(text)` | `{{n}}` 的生成、解析、取集合；`parsePlaceholder` 只认整串（insert.js :124 的锚定式） |
| `placeholderPattern()` | 每次调用返回**新的**全局正则（模块级不共享 `/g` 实例，`lastIndex` 不串味） |
| `openTag(name, i)` / `closeTag(name, i)` | collect.js :787/:798 的拼接 |
| `markerPattern()` | 严格匹配，标志 `gi`（`i` 不能丢：内置 NMT 会把 `<a1>` 大写成 `<A1>`，collect.js :26 的注释）；每次新实例 |
| `markerParsePattern()` | 宽松解析（模型改了空白也认，insert.js :146 的形状）；每次新实例 |
| `debrisScrubber(markupElements)` | `→ (text) => text`，与 #114 的 `markupDebrisScrubber`（insert.js :24-47）同形同义（修-C）：只认本块真正生成过的标签名；编号那一段要能整个拆成本块发过的编号（1111 = 11·11，1213 = 12·13），拆不开的一个字不动；拆分在替换回调里做、不写进正则（互为前缀的交替会指数回溯）；对空白和大小写宽容 |
| `strip(text)` | 去掉占位符和标记，给上下文、计数和语言检测用（content-language.js :112-113，collect.js :44-47） |
| `segments(text)` | `[{kind: 'text'\|'placeholder'\|'marker', value}]`，拼回去等于原文；词表只在 `text` 片段里匹配 |
| `splitSafe(text, at)` | 切片时不把占位符切成两半（batch.js :81 `avoidPlaceholderSplit` 和引擎 :274-278 的定长切都用它） |

守卫单测 `test/unit/text-markers.test.mjs`（取代 `markup-marker-regex.test.mjs`，修-11）：占位符和 `<a1>` 这类标记的正则字面量只许出现在 `shared/text-markers.js` 和 `test/` 里；`background/prompts.js` 给模型看的说明文字（:11/:59/:72）是字符串不是正则，扫描按正则字面量判，不误报。

## 3. 生效点与缓存（C1）

### 3.1 顶层帧的词表镜像：`content/content-glossary.js`（shelf `ctx.glossary`）

| 成员 | 作用 |
|---|---|
| `init()` | 建镜像（§2.5）。在 `ctx.init`（`content-bootstrap.js` :249）里和 `ctx.customRules.init()`（:253）一起发出，不串行；`whenReady` 与 :271 的 `await ctx.customRules.whenReady()` 并列 |
| `whenReady()` | 就是镜像的 `whenReady()`：首个回话到达，或者 1500 ms 到了，就 resolve。超时按「没有词表」处理，回话晚到照常生效，与 B§3.1 同一口径 |
| `entries()` / `version` / `subscribe(fn)` | 镜像原样给出（`sync-collection.js` :248 的 `mirror` 返回 `{whenReady, onStorageChange, entries, version, subscribe}`）；`version` 只是记忆键 |
| `onStorageChange(changes)` | 经 `ctx.syncMirrors.push({prefix: Glossary.prefix, onStorageChange})` 登记，接收 `routeSyncMirrors`（:150-166）转来的 `glossary:` 增量 |

- 只有顶层帧建镜像（`ctx.frameRole`，bootstrap :12；`ctx.init` 里 :267 已按它分支）。子帧不建、不登记（修-4）。
- `ctx.requestTranslation`（引擎 :655）开头把 :658 的 `await ctx.customRules.whenReady()` 改成 `Promise.all([ctx.customRules.whenReady(), ctx.glossary.whenReady()])`，两者都要判空（设置页加载引擎这一族，那里两个 shelf 都没有，:656-657 的注释已说明）。
- 没有 `ctx.glossary` 的地方（设置页、Node 测试台）快照是空的（§3.3）。这是「这里本来就没有词表」，不是出错后的兜底。

### 3.2 匹配器：`content/engine/glossary.js`（`ctx.engine.glossary`）

**编译**（输入是 `Glossary.pick(entries, host, targetLang)` 的结果：作用域过滤、同原文只留胜者，§2.3）：

- 区分大小写的词条编成一个带 `u` 的正则，不区分的编成一个带 `iu` 的正则，都带 `g`。每组的备选按原文长度降序排，同样长的按原文字典序排，保证编译结果稳定。
- 每条原文先 `normalizeSource`，再转义正则元字符，内部空白换成 `\s+`。
- 词边界只加在需要的一侧：首字符属于 W，前面加 `(?<!W)`；末字符属于 W，后面加 `(?!W)`。
  - W = 拉丁、西里尔、希腊三种文字的字母（`\p{Script=Latin}`、`\p{Script=Cyrillic}`、`\p{Script=Greek}`），加 `\p{Nd}`、`\p{M}`。
  - 所以「GPT-4」两头都要词边界，「注意力」两头都不要，「C++」只有前面要。
- 不用内联修饰符 `(?i:...)`：Chrome 125 才支持，`manifest.json` 的 `minimum_chrome_version` 是 116。分成两个正则就是为了不用它。

**匹配**（`match(text)`，只在 `TextMarkers.segments(text)` 的 `text` 片段里跑）：

1. 从位置 p 起，两个正则各 `exec` 一次（先把 `lastIndex` 设成 p）。
2. 取起点小的那个；起点相同取长的；再相同取区分大小写的。
3. 记下命中，p 跳到命中的终点，重复到片段结束。

结果是最左、最长、不重叠。正则对象属于快照，不跨快照共享。

### 3.3 快照

`ctx.engine.glossary.current(targetLang)` 先等 `ctx.glossary.whenReady()`，再返回快照。快照不可变：

| 成员 | 说明 |
|---|---|
| `version` | 镜像版本 × 目标语言 × 顶层主机。同一组合只编译一次（记住最近一个） |
| `match(text)` | §3.2 的命中列表 `[{start, end, entry}]` |
| `stamp(text)` | 这段文字命中的词条的规范串：每条是大小写标志、规范原文、译文（或「保留原文」标记），去重、排序后拼起来；没命中是 `''`（§3.7） |
| `plan(texts)` | 给 AI：`[{indices, glossary: [{s, t?}]}]`，按 §3.4 的 60 条上限切成几份 |
| `protect(text, firstId)` | 给内置引擎：`{text, ids, restore(out)}`（§3.6） |

- 快照在请求开始时取一次。这一次请求的缓存键、提示词、占位符都出自同一个快照；请求在途时词表变了，只影响下一次请求。
- `requestTranslationCached`（`content/content-translation-cache.js` :59）取一次快照，传给 `ctx.requestTranslation(message, {glossary: snap})`（:80、:100 两处）。
  - `ctx.requestTranslation(message, opts)` 用 `opts.glossary`，没传就自己取。
  - 第二个参数只在内容脚本内部传，不进消息，不过 `sendMessage`。
- 空快照：`match` 返回 `[]`，`stamp` 返回 `''`，`plan` 只有一份不带词表的，`protect` 原样返回。

### 3.4 AI 出口：`sendToModel`

- `requestTranslation` 末尾那几行（:700-703：`refuseAutoAiSpend`，然后 `sendMessage`）收进一个函数 `sendToModel(message, snap)`。它仍是**唯一**一个发给模型的出口，:695-699 的注释跟着搬过去。
- 每一份的附加说明是 `{glossary, domain, context}`（§3.5）。没有内容的字段不写；三样都没有时，消息里不带 `addenda`。
- **60 条上限**：`plan(texts)` 按文字顺序往一份里装，装进下一段会让这一份的词条并集超过 60，就开新的一份。
  - 一段文字自己就命中超过 60 条时，这一段单独成一份，只带命中次数最多的 60 条（次数相同的按首次出现排），被舍掉的条数记进 `stats().overflowEntries`。
  - `TRANSLATE`（单条）只有一份，不切。
- **一份一份依次发，不并发。**
  - 每一份各自过 `refuseAutoAiSpend`，各自计费。
  - 任一份失败（有 `error`，或 `translations` 不是等长数组），就原样返回那一份的响应，后面的不再发，由上层现有的错误处理和数量守卫接手。
  - 已经发出去的几份，额度不退（§7）。
  - 全部成功时，按 `indices` 把译文拼回原顺序。

### 3.5 AI 附加说明（词表在 C1，领域和上下文在 C3）

**消息**：三种翻译消息（`TRANSLATE` :109、`TRANSLATE_BATCH` :115、`TRANSLATE_BATCH_FAST` :121）多一个可选字段：

```js
addenda: {
  glossary: [{ s: 'attention', t: '注意力' }, { s: 'Transformer' }], // 没有 t = 保留原文
  domain: 'tech',                                                   // PromptAddenda.DOMAINS 之一
  context: { title: '…', before: '…', after: '…' }                  // 只在开关打开时有
}
```

**SW**：

- 三个处理函数（`background/background.js` :321/:340/:359）先 `PromptAddenda.validate(message.addenda)`，再计字数，再调模型。不合法就抛，处理函数按现有方式回 `{error}`。内容脚本造不出不合法的附加说明，走到这里只能是 bug，所以不截断、不忽略。
- `addenda` 一路传到 `background/ai-translate.js` 的五个函数（:90/:123/:159/:172/:216）和回落（:272 之后的 `parseNumberedResponse` 分支）。`delimiter` 仍是消息上的字段，不并进 `addenda`。
- `background/prompts.js` 新增 `composePromptAddenda(addenda)`。`buildPrompt` 的 `options` 收 `addenda`，拼出的块放在模板之后、数学规则之前：:85 和 :87 两个 `return` 都改，单词翻译那条分支一样带。

**块的写法**（给模型看，用英文；用户和页面来的字符串一律 `JSON.stringify`，引号和换行都会转义）：

```text
GLOSSARY (user-defined; overrides any general rule about keeping terms in their original form):
- "Transformer" → keep as written
- "attention" → "注意力"
DOMAIN: <PromptAddenda 里这个领域对应的一句英文>
PAGE CONTEXT (reference only; do not translate it and do not include it in the output):
{"title":"…","before":"…","after":"…"}
```

- 第一行写明它压过 :28/:38/:56 的「术语保留原文」（§0.1-11）。
- 领域是一句英文，按 `PromptAddenda.DOMAINS` 的 id 取；`general` 不写这一行。
- 上下文是一段 JSON，标明只作参考。
- 附加说明里不会出现 `segments are separated by "` 这串字：页面和用户来的双引号经 `JSON.stringify` 都带了反斜杠。`test/e2e/mock-openai-server.js` :17 的 `PROMPT_DELIMITER_RE` 靠这句话找分隔符，用单测钉住。

**计数**：

- 新增 `AutoStats.sentChars(source, addenda)` = `textsChars(source)`（`shared/auto-stats.js` :114）+ 上下文三个字段的字数。词表和领域不计：词表是用户自己写的，额度量的是「网页上有多少字被送了出去」。
- 它替换引擎 :491 和 ai-translate :160/:174/:217 的计数。
- 扫描单测：`textsChars(` 只准出现在 `shared/auto-stats.js` 里。`test/unit/auto-translate-wiring.test.mjs` :388 那条「出现两次」的断言跟着改。

### 3.6 内置引擎：占位符保护

- `withGlossary(snap, text, run)` 包住 `handleWithBuiltin`（:548）里的两处 `translateWithBuiltin` 调用：`TRANSLATE` 的 :562，批量逐段的 :585。`handleWithBuiltin(message, snap)` 多收一个快照。
- `protect(text, firstId)`：命中的词条换成 `TextMarkers.placeholder(n)`，n 从这段文字里已有占位符的最大号加 1 起编。每段最多 20 个，按命中顺序，第 21 个起不换（§7）。
- 送给引擎的是保护后的文字，**源语言仍按原文判**：`translateWithBuiltin`（:308）的 options 加 `detectText`，传给 `eng.resolveSourceLang`（`content/engine/languages.js` :212；:317 是调用点）。换掉词条以后，短文本可能一个字母都不剩（`Transformer attention` 变成 `{{1}} {{2}}`），`detectLanguageOf`（:77）和 `detectStandaloneLang`（:179）就都没了依据。
- 配额切分：`splitForQuota`（:268）优先用 `ctx.splitTextIntoChunks`（`content/page/batch.js` :93，导出 :658），它本来就不会把占位符切开；退化分支（:274-278 的定长切）改用 `TextMarkers.splitSafe`。
- **还原**：`restore(out)` 把「保留原文」的词条换回原文，有译文的换成译文。
- **引擎原样吐回保护后的文字**（同语言，或者没译）时，返回**原文**，不做还原。否则会得到「原文里夹着译文」的句子。
- **占位符丢了**：
  - `translateWithBuiltin` 里 :392-393 抛的普通 `Error` 换成 `eng.PlaceholderLossError`（定义在 `EngineUnavailableError` :123 旁边并导出），带上 `lost`（丢了的 id）。`keepsPlaceholders`（:241）不用改，它本来就把文字里所有的 id 一起查。
  - `withGlossary` 接住它。`lost` 里有词表的 id：记一次日志（`Blab Translation: builtin translator dropped glossary placeholders`，带 `lost`），`stats().placeholderLosses` 加 1，然后**不带词表**把原文再译一次。只丢了数学占位符：原样往上抛，和今天一样。
  - 重译还丢，就往上抛。批量走 :588-600 的 catch（记日志，推 `''`，上层按「跳过、保留原文」处理）；单条走 :679-687 的 catch（今天数学占位符丢了也走这里）。
  - 重译不是回落：引擎戳还是 `builtin`，钉住的引擎不变，也不花 AI 额度。
- `stats()` 返回 `{protectedSegments, placeholderLosses, overflowEntries}`，只给测量脚本和单测读（§6.3）。

### 3.7 缓存键：第八个因子 `addenda`

- `shared/translation-cache.js`：
  - `FACTORS`（:102）在 `version` 之后加 `'addenda'`。
  - 顶上的因子表「七个因子」改成「八个」，加一段 `addenda` 的说明（就是下面这一条）。
  - `serve`（:188）的 JSDoc 改成「除 text 之外的键因子，值可以是 `(text) => string`」。
- **因子可以是函数**：`serve` 按每段文字求值再建键。`buildKey`（:104）收到函数就抛 `TypeError`：函数只该在 `serve` 里求值，漏到 `buildKey` 就是调用方写错了。
- **`addenda` 的值是这段文字的戳** = `snap.stamp(text)` + 领域 id + 上下文开关。只放决定「这段怎么译」的东西：
  - 只含这段命中的词条，所以改一条词条，只有含它的文字失效；
  - 上下文只进开关，不进内容。前后文每段都不一样，放进键里就等于不缓存；同一段文字换一份上下文译出来的结果，可以复用。
- 上线那一刻所有键都会变一次（拼接多了一段）。每次发版 `version` 本来就让全部键失效，所以不另做迁移。
- `content/content-translation-cache.js` 的 `factors` 加 `addenda: (text) => addendaStamp(snap, text)`。`addendaStamp` 放在 `content/engine/addenda.js`，与 §3.4 拼附加说明是同一个模块。

### 3.8 本地缓存的代数：`ctx.translationProfile`

悬停（`content/hover/blocks.js` :75-77 的 `buildCacheKey`）和字幕（`content/captions/translate.js` :18-20 的 `getCueKey`）各有一份内存缓存，键里只有目标语言和原文（字幕另有轨道和时间），没有模型、提示词和词表。改了词表、领域或模型，它们会继续给旧译文。

`ctx.translationProfile` 放在 `content/content-translation-cache.js`（缓存的事归缓存文件）：

| 成员 | 说明 |
|---|---|
| `generation()` | 当前代数，从 0 起 |
| `subscribe(fn)` | 代数变了就回调 |
| `onSettingsChanged(changes)` | bootstrap 的 `ctx.setupStorageListener`（:169）在 `routeSyncMirrors` 之后、:185-187 写完 `ctx.settings` 之后把剩下的 sync 增量转过来。这些键任一变了就加一代：`apiEndpoint`、`modelName`、`customPrompt`、`translationEngine`、`autoTranslateEngine`、`engineFallback`、`promptDomain`、`aiPageContext`、`provider`。`PROFILE_KEYS`（:16）里的键变了，同时清掉 `profilePromise` |
| `inherit(g)` | 子帧专用，跟着顶层指令里的代数走 |

- 另外两个加代时机：
  - 词表：订阅 `ctx.glossary`。本页生效的词条（`forHost` 之后的条目）签名是 id 加 `u`，签名真变了才加一代（B§12.3 的签名门）。
  - 规则：订阅 `ctx.customRules.onProfileChange`（C3 加，`engineOverride()` 或 `domain()` 变了才回调）。
- 删掉缓存文件自己的 `storage.onChanged`（:50-52），改由 bootstrap 统一通知。sync 的监听只剩 bootstrap 一处。
- 悬停和字幕的键前面加上代数。悬停今天是 `` `${targetLang || ''}::${text}` ``（`blocks.js` :75-77），字幕今天是 `` `${targetLang}|${trackId}|${startMs}|${text}` ``（`captions/translate.js` :18-20）。键本来就在 `await` 之前取（`content/content-hover-translation.js` :159，`content/hover/selection.js` :232，字幕 :56-64），代数跟着一起定下来。请求在途时换了代，回来的译文存在旧键下，不会再被读到。
- **iframe 的代数**：
  - 顶层指令带 `generation`：`computeDirective`（`content/frames/top.js` :44）加这个字段，`sameDirective`（:54）比较它，`setupTopFrame`（:159）订阅代数变化并调 `refreshDirective`（:75）。
  - 子帧 `applyDirective`（`content/frames/child.js` :167）调 `ctx.translationProfile.inherit(directive.generation)`。
  - 领域不下发给子帧：子帧的请求在顶层执行，领域在顶层加。
- **子帧的请求信封加 `via`**：
  - 子帧发 `{type: 'FRAME_ENGINE_REQUEST', via, message}`，`via` 是 `'cached'` 或 `'direct'`（`requestTranslationViaTop`，`child.js` :74-81）。
  - `background/frame-relay.js` :75-76 原样转成 `{type: 'FRAME_ENGINE_RELAY', via, message}`。
  - 顶层 :149 交给 `relayEngineRequest`（:126）：`'cached'` 调 `ctx.requestTranslationCached`，`'direct'` 调 `ctx.requestTranslation`，别的值抛错。
  - 子帧 :226 把 `ctx.requestTranslation` 和 `ctx.requestTranslationCached` 都换成 `requestViaTop(via)`。manifest 里缓存文件（:124）排在 child（:168）之前，所以覆盖得到。:61-73 的 JSDoc 重写：它 :63-64 说缓存层留在子帧先查，改完就不对了。
  - 调用方都在调用时才读这两个函数（`captions/translate.js` :86，`batch.js` :38-39 的 `requestBatch`），不存引用，所以覆盖能生效。
  - 结果：子帧的缓存命中和未命中，从此记在顶层帧的 `AutoStats` 里。

### 3.9 `TextMarkers` 迁移（D-314：收齐所有副本）

| 文件 | 行 | 今天 | 改成 |
|---|---|---|---|
| `content/content-translation-engine.js` | :225-239 | `PLACEHOLDER_RE`（模块级 `/g`）、`placeholderIds` | `TextMarkers.placeholderIds` |
| `content/content-hover-translation.js` | :156 | 占位符正则 | `TextMarkers.strip` |
| `content/hover/selection.js` | :41 | 同上 | 同上 |
| `content/hover/latex.js` | :95 | 模板串拼占位符 | `TextMarkers.placeholder(n)` |
| `content/content-language.js` | :112-113 | 占位符正则，加 `ctx.MARKUP_MARKER_RE \|\| /<\/?[a-z]+\d+>/gi` 的字面量兜底 | `TextMarkers.strip`；兜底和 :106-110 讲兜底的注释（引用的 `content-page-translation.js` 已不存在）一起删 |
| `content/page/collect.js` | :33、:44-47、:686、:787/:798、:951-952、:961 | `MARKUP_MARKER_RE`、`stripPlaceholders`、占位符拼接、标记拼接、`normalizeComparableText` 里的两个正则、`ctx.MARKUP_MARKER_RE` 导出 | `TextMarkers` 对应成员；导出删掉（读它的只有 content-language.js :113） |
| `content/page/batch.js` | :81-91 | `avoidPlaceholderSplit` 手写的回退 | `TextMarkers.splitSafe` |
| `content/page/insert.js`（P0 + #114） | :43、:75、:124、:146 | `markupDebrisScrubber` 里的字面量、`appendTextWithMath` 的 `placeholderRe`、锚定式 `/^\{\{(\d+)\}\}$/`、宽松 `markerRe` | `debrisScrubber`（:24-47 整个函数搬进 `TextMarkers`，:404 的调用点改名）、`placeholderPattern`、`parsePlaceholder`、`markerParsePattern`（§12-1） |

- 通用语法与逐块清理分开（D-314）：`markerPattern()` 是「这是不是标记」，`debrisScrubber(markupElements)` 是「这块该删哪些残片」，后者只认本块的标签和编号。
- 加载顺序：`shared/text-markers.js` 在 manifest 里排在 `content/content-language.js`（:118）和引擎（:122）之前；`options.html` 排在 `content/engine/languages.js`（:954）之前；`test/e2e/helpers.js` 的 `PAGE_TRANSLATION_MODULES`（:47）排在 `'content/content-language.js'`（:83）之前；`engine-harness.mjs` 的 import 表（:95-100）排在 `content/engine/languages.js` 之前；`site-rules.test.mjs` 的 `LOAD_ORDER`（:796）加一行 `['content/content-language.js', 'shared/text-markers.js', …]`。
- 守卫单测 `test/unit/text-markers.test.mjs`（修-11、修-12）：
  - 扫描：占位符和标记的正则字面量只准出现在 `shared/text-markers.js` 和 `test/` 里。
  - `markerPattern().flags` 含 `g` 与 `i`（原 `markup-marker-regex.test.mjs` 的 `i` 断言搬过来）。
  - 工厂不共享实例：`placeholderPattern()` 调两次得到两个对象；对两段不同文字交错 `exec`，两边都走完各自的全部命中。`markerPattern()` 同样测。
  - `debrisScrubber` 的语义用例从原文件搬来（自有标签才删、1111/1213 的拆分、拆不开不动、5000 位数字线性时间）。
  - 加载顺序：读 manifest 和 helpers.js 源码（照 `translation-display.test.mjs` :324 的做法），断言两处都在 `content/content-language.js` 之前。
- `test/unit/markup-marker-regex.test.mjs` 在同一个改动里删掉。

## 4. 设置页（C2 术语表卡片、C3 领域与页面上下文）

### 4.1 术语表卡片（C2，`options/options-glossary.js`）

**位置与加载**

- `options.html` 在 `<!-- Custom Prompt -->`（:789）前插入 `<section id="glossaryCard" class="settings-card settings-card-full">`。词表和提示词是同一件事的两半，放在一起。这个 section 是空的挂载点，卡片里面的标记由 `options-glossary.js` 的 `GLOSSARY_CARD_MARKUP` 加载时填进去（勘-9）。
- 脚本顺序：`shared/text-markers.js` 排在 `content/engine/languages.js`（:954）之前。`shared/prompt-addenda.js`、`shared/glossary.js`、`shared/glossary-csv.js` 排在 `shared/custom-rules.js`（:945）之后、`shared/settings-transfer.js`（:984）之前。`options/options-glossary.js` 排在 `options-custom-rules.js`（:979）之后、`options/options-transfer.js`（:985）之前，因为整份导入要调它的预览函数（§4.2）。
- 按 `CLAUDE.md`，新的 `content/engine/*` 文件同时进 manifest 和 `options.html`：`content/engine/glossary.js`、`content/engine/addenda.js` 排在 :956 的引擎之前，顺序与 §3.9 的 manifest 顺序相同。

**卡片内容**

| 部分 | 内容 |
|---|---|
| 头部 | 标题「术语表」，一句说明「指定某个词怎么译。AI 翻译按它译，内置翻译保持原文不动。」，用量「已用 x KiB / 32 KiB · n / 300 条」（`SyncCollection.usage`） |
| 工具行 | 搜索框（按原文、译文、站点过滤，只在页面上筛，不读存储）、「添加词条」「导入 CSV」「导出 CSV」 |
| 列表 | 一行一条：原文 → 译文（空则显示「保留原文」），小标签：区分大小写 / 站点 / 目标语言；「编辑」「删除」。空态「还没有词条。」 |
| 表单 | 添加与编辑共用：原文、译文（留空 = 保留原文）、「区分大小写」复选框、站点输入（留空 = 所有网站，失焦时用 `SiteRules.normalizeHost` 规范化后回填）、目标语言下拉（首项 `*`「所有目标语言」，其余来自 `TargetLang.options`） |

- 「区分大小写」：添加时，原文含大写字母就默认勾上（§2.2）；编辑时照条目原样。
- 保存调 `Glossary.request('put', {entry})`（编辑时带 `id`）。删除调 `request('remove', {ids: [id]})`，不弹确认：设置页唯一的 `window.confirm` 是 B2 的 `confirmUnattendedAiSpend`（`options-custom-rules.js` :271-298 里调用，B§0.1-19），词表不再加一个。
- 请求抛出的 i18n 键原样显示在表单下方：`glossaryEntryInvalid`、`glossaryEntryTooLarge`、`glossaryBudgetFull`、`glossaryDuplicate`、`glossarySaveFailed`。表单保持打开，存储不动。
- 跟随：卡片自己挂 `storage.onChanged`，用 `applyChanges(entries, changes, null)` 更新后重绘列表和用量，与规则卡片同一做法（`options-custom-rules.js` :531）。B§2.6 的防抄写扫描只管内容脚本模块，不管设置页卡片。

**导入 CSV**

1. 选文件后 `file.text()`，交给全局函数 `previewGlossaryImport(text)`。它调 `GlossaryCsv.previewImport(current, text)`，`current` 现读存储（同 `previewCustomRulesImport` :75-79 的理由：整份导入可能在卡片读回来之前就点了），返回 `{added, replaced}`。卡片和整份导入（§4.2）共用这一个函数。
2. 卡片内出现一行确认：「将新增 {added} 条、替换 {replaced} 条」（`glossaryImportPreview`），以及「导入」「取消」。不用 `window.confirm`。
3. 有坏行时整份拒绝，显示「第 {row} 行无效，没有导入任何内容。」（`glossaryImportInvalid`）。超额显示 `glossaryBudgetFull`。
4. 点「导入」调 `Glossary.request('import', {csv: text})`。SW 重新解析、校验、合并（§2.4），不信设置页算出的结果。

**导出 CSV**：`GlossaryCsv.serialize(entries)` 生成 Blob（`text/csv;charset=utf-8`），经 `<a download="blab-glossary-YYYYMMDD.csv">` 下载，日期取本地日期。做法与规则卡片的导出相同（B§4）。

### 4.2 设置整份导入导出里的「术语表」一节

按 B§12.4 的 P0-F 接口，在 `TRANSFER_SECTIONS`（`options/options-transfer.js` :194）里 `customRules` 之后加 `glossary` 一行，用 `collectionSection(spec)`（:143）包，形状照 `customRulesSection`（:168-192）：

| 成员 | 做法 |
|---|---|
| `collect()` | `GlossaryCsv.serialize(全部条目)`。这一节的值就是 CSV 文本，和卡片导出的文件是同一份东西（规则一节的规矩：小节值与卡片导出文件同一对象，:172）。与 `includeApiKey` 无关 |
| `validate(raw)` | 不是字符串就 `sectionInvalid`；否则 `previewGlossaryImport(raw)`，返回 `{value: raw, accepted: added + replaced, dropped: [], added, replaced}`（同 :175-179） |
| `preview(result)` | 一行 `transferPreviewGlossary`：「术语表：将新增 {added} 条、替换 {replaced} 条。」（同 :182-186 的 `lines`，没有 `warnings`；勘-6） |
| `apply(value)` | `Glossary.request('import', {csv: value})`（同 :189-191） |

- `COLLECTION_REFUSALS`（:122-127，:120 的注释已经说「P1-C 往同一张表里加术语表的键」）加五行：`glossaryImportInvalid`、`glossaryEntryInvalid`、`glossaryEntryTooLarge` → `sectionInvalid`；`glossaryBudgetFull` → `sectionBudgetFull`；`glossarySaveFailed` → `sectionSaveFailed`（只在写入时出现）。`TRANSFER_REASON_KEYS`（:130-134）不用加行，三种理由键已经在。
- `TRANSFER_SECTION_NAMES`（:216-220）加 `glossary: 'transferSectionGlossary'`。十种语言的 `transferDesc`（en.js :515）加「术语表」，B§12.4 的单测（zh-CN 和 en 的 `transferDesc` 含每个小节名）自动管住它。
- 新设置 `promptDomain`、`aiPageContext` 走 `settings` 一节。`buildEnums`（`shared/settings-transfer.js`）加参数 `domains`，由调用方传 `PromptAddenda.DOMAINS`，不抄一份列表。

### 4.3 领域与页面上下文（C3）

**两项新设置**

- `promptDomain: 'general'`、`aiPageContext: false`。
- 加进三处默认值：`shared/default-settings.js` 的 `CONTENT_DEFAULTS`（:41，挨着 `translationStyle` :62）；`background/settings.js`（挨着 `customPrompt` :67）；`options/options.js` 的 `defaultSettings`（:128，挨着 :198）。
- `options.js` 还要改 `elements`（:86）、`loadSettings`（:286）、`collectSettings`（:402），并加进 `IMMEDIATE_SAVE_FIELDS`（:550），这样 `options-sync-mirror.js` 会同步它们。

**界面**：放在自定义提示词卡片里，三个风格预设按钮（`options.html` :807-822，`#presetStandard` / `#presetLiteral` / `#presetCreative`）之后、文本框（:832-834）之前。

- 「领域」下拉：九项，顺序同 `PromptAddenda.DOMAINS`，默认「通用」。说明文字：「AI 会按这个领域的用语翻译。站点规则里设了领域的网站，以规则为准。」
- 「附带页面上下文」复选框：默认关。说明文字：「把网页标题一起发给 AI 服务，译得更连贯：翻译整页时还附上前后各一小段文字，自动翻译只附标题。发出的文字会比要翻译的多，也会多用一些额度。」（C3 修复回合 1，裁定 1：原文案「标题和前后各一小段」对自动翻译不成立，收窄承诺。）
- 存储里的领域不在 `PromptAddenda.DOMAINS` 里（裁定 2）：下拉旁显示 `promptDomainUnknown`，任何保存都被拒（状态条说同一句），不强转「通用」、不写空串；选一个合法领域存下后收起。内容脚本那边同一个值让 `effectiveDomain()` 抛一个带 `passFatal` 的错误，整页一轮第一次见到就停并在进度条上报出来（裁定 3）。
- 与三个预设的关系：预设（`options.js` :121 的 `PROMPT_PRESETS`）改写的是 `customPrompt` 文本本身。领域是另一段结构化附加说明（§3.5），两者同时生效，谁也不改谁。选领域不动文本框。

**站点规则的领域**（修-7、修-8、修-B）

- `shared/custom-rules.js`：`VERSION` 改成 `VERSIONS = new Set([1, 2])`；`normalizeRule`（:149-164）收 `domain`（`PromptAddenda.DOMAINS` 之一，否则 `customRuleInvalid`），有 `domain` 才写 `v: 2`，否则 `v: 1`（B§2.2「最低版本」）；`decode`（:186-187）收 1 和 2，其余返回 null；`pick`（:218）不动。`custom-rules.test.mjs` :89 与 :205 的 `v: 2` 改成 `v: 3`，另加两条（修-B）。
- `options-custom-rules.js`：`CUSTOM_RULE_FIELD_LABELS`（:41-47）加 `domain` 行；`domainField(form, value)` 照 `engineField`（:271-298）写，首项「跟随全局设置」（不写字段）；`openCustomRuleEditor`（:300）挂进表单；`readEditor`（:377-380）照 `engine` 的写法 `if (editor.domain.value) draft.domain = …`；`saveCustomRule`（:420-426）不改，`validateRule` 自己会拒。
- `content/page/custom-rule.js`：`current()`（:55-70）的冻结对象加 `domain`；`ctx.customRules.domain()` 返回它，没有就 `null`。多条规则命中时，`pick` 的胜者就是这一条，和其他字段一样。`signatureOf`（:78-83）不加 `domain`（§0.1-17）。
- 加 `onProfileChange(cb)`：签名 = `engineOverride()` + `domain()`，变了才回调。§3.8 的 `generation` 靠它递增。
- 有效领域 = `ctx.customRules.domain() ?? settings.promptDomain`。规则写「通用」也算写了，此时不发领域句子。

**页面上下文**：在 `sendToModel`（§3.4）里、额度门之前组装。只在 `aiPageContext` 开着而且这次走 AI 时附带，内置引擎一律丢弃。

| 入口 | 标题 | 前后文 |
|---|---|---|
| 整页批量（`content/page/batch.js` :396/:541/:605 三处取材，都经 `requestBatch` :38-39 一个出口） | 有 | 有：这一批第一段之前、最后一段之后的相邻段落（按收集顺序） |
| 自动翻译（`content/content-auto-translate.js` 按视口成轮，每轮一次 `runTranslationPass(…, {auto: true})`） | 有 | 无：按视口成轮，一轮里的块是这一屏新出现的，彼此不一定相邻，没有可靠的邻段；`runTranslationPass` 对 `auto` 一律不取前后文，一轮拆成多批也一样（裁定 1） |
| 悬停（`content/content-hover-translation.js` :182、`content/hover/selection.js` :265） | 有 | 无 |
| 划词卡片与图片 OCR（`content/content-popup.js` `translateText` :581，导出 :676；OCR 经 `content/content-image-ocr.js` :370 调同一个 `ctx.translateText`） | 有 | 无 |
| 字幕（`content/captions/translate.js` :86） | 有 | 无 |
| 输入框翻译（`content/content-input-dialog.js` :274，`standaloneText`） | 从不 | 从不 |
| 设置页 | 从不 | 从不 |

- `batch.js` 三处共用一个取前后文的函数。只在本帧 `ctx.settings.aiPageContext` 开着时计算，放进消息的 `pageContext: {before, after}`。
- 标题由执行请求的顶层帧取 `document.title`（子帧的请求经 §3.8 的信封到顶层执行）。
- 长度在组装时截到 `PromptAddenda.LIMITS`：`before` 取前一段的最后 300 字，`after` 取后一段的前 300 字，标题取前 200 字，都先过 `TextMarkers.strip`。`PromptAddenda.validate` 在 SW 里仍然拒绝超限的附加说明：组装层负责截断，SW 负责把关，超限只可能是缺陷。
- 前后文算进 `AutoStats.sentChars`（§3.5）。
- 隐私政策：`privacy-policy.md` §一（:37）加一段，说明三件事：「附带页面上下文」开着时，网页标题和每批前后各至多 300 字会发给你配置的 AI 服务，默认关；术语表里与这段文字匹配的词条会随请求发给同一个服务；内置翻译不发送这两样。§三（:131-142）的存储表加一行「术语表：`chrome.storage.sync`，随你的浏览器账号同步」，与 :137 的规则那一行并列。§六（:180-186）「你电脑上的」一段加「术语表」。

## 5. 划词卡片「加入术语表」（C4）

**按钮**：`content/content-popup.js` 的动作行，在换引擎（:113）和复制（:114）之间插一个按钮：

```js
<button class="ai-translator-btn ai-translator-add-term" type="button" hidden>${ctx.fitLabel('', [t('glossaryAdd'), t('glossaryAdded'), t('glossaryUpdated')])}</button>
```

- 文字会在「加入术语表 / 已加入 / 已更新已有词条」之间换，宽度靠 `ctx.fitLabel`（`content/content-utils.js` :141）按最宽的那种字定下，不跟着字变（`content/css/popup.css` :673-685 的 `data-fit` 影子）。

**什么时候露出**

- 在 `settleCardActions`（:535）开头、`await switchOffer` 之前同步决定。条件：这次结算成功出了译文，而且 `Glossary.normalizeSource(原文)` 长 1–80 字。
- 露出之后，重译和换引擎期间保持原样，不先藏再露。这和换引擎按钮是同一条规矩，J-D9（`test/e2e/selection-card.spec.js` :614）量动作行几何时它已经定下了。换了原文、开了新卡片才重新决定。
- `setCardActionsBusy`（:522-526）的选择器加上 `.ai-translator-add-term`：请求在路上时禁用，免得拿旧译文去预填。
- **点击后改字也进 J-D9 的点击清单**（D-314、修-13）：J-D9 的旅程里点一次「加入术语表」并保存，按钮变成「已加入」之后再量一次动作行，几何与点击前相同。

**点击后**：在卡片里展开一个小表单。它在 `.ai-translator-popup` 之内，所以不是新的面板根，不用进 `popup.css` 的 `:is()` 列表。以后若改成独立浮层，就必须加进去。

| 字段 | 内容 |
|---|---|
| 原文 | 只读，显示规范化后的原文 |
| 译文 | 输入框，预填这次的译文。超过 160 字也照样预填，保存时报 `glossaryEntryInvalid` |
| 范围 | 「仅本站（{host}）」/「所有网站」，默认仅本站。`host` 为空时（`file:`、`about:blank` 等）只有「所有网站」 |
| 按钮 | 「保存」「取消」 |

- 区分大小写不在小表单里出现，按 §2.2 的缺省规则定：原文含大写字母就区分。目标语言取这张卡片的目标语言（`popup.dataset.targetLang`），不写 `*`。
- `{host}`：顶层帧用 `SiteRules.normalizeHost(location.hostname)`。子帧显示顶层的主机：`content/frames/top.js` 的 `computeDirective`（:44）加 `host`，`sameDirective`（:54）一并比较。这只影响显示，存进去的 `h` 永远由 SW 按 `sender.tab.url` 重算（§2.4，修-A）。
- 保存调 `Glossary.request('put', {entry: {s, t, c, l}, scope: 'site' | 'all'})`。回话 `{id, replaced}`：按钮文字换成「已加入」或「已更新已有词条」，表单收起。出错时在表单里显示错误键对应的句子，表单不收。
- 当前卡片的译文不自动重译。页面的词表镜像经 `storage.onChanged` 更新、`generation` 递增（§3.8）之后，下一次翻译就会用上新词条；用户想马上看效果就点「重译」（:112）。旅程 C-J7 断言这一点。
- 不碰剪贴板，没有「已复制」状态，没有快捷键。
- i18n 键放在各语言文件新开的 `// Glossary (P1-C)` 段里。

## 6. 验收：旅程、承诺与单测

验收以旅程为单元，结论只有「步骤 N 一致 / 偏差」。夹具只用来隔离子步骤，每处都标 `[fixture]`；入口一律走真实界面（设置页点选、页面上划词、悬浮球翻译），不直开深链。

**测试台要补的三样**（都在 `test/e2e/helpers.js`，只有它可以用 `Runtime.executionContextCreated`）：

- `stubBuiltinTranslator`（:529，已收 `pageOrFrame`）加选项 `{dropPlaceholders}`，模拟内置引擎吃掉占位符；另记 `__builtinTexts`（收到的原文），与现有的 `__builtinCalls`（:532/:536）并列。
- `test/e2e/mock-openai-server.js` 记下每次请求的 system prompt（`systemPrompts`），旅程据此断言附加说明块。
- 等待只有两种判据，不另写等待办法：
  - **内容脚本就绪**：先设 `translationStyle: 'underline'`，再轮询页面上的 `data-ai-translator-style`（`waitForContentReady`），看到了说明设置已经读进来。断言「点下去会发生什么」（点悬浮球、划词、悬停）之前用它。
  - **持久缓存落盘**：轮询 `chrome.storage.local` 里 `tc:` 开头的键数（`countPersistentCacheKeys`，`test/e2e/helpers.js`），等到它等于送出去的段数。断言「刷新后再翻不再发请求」（C-J5 第 1 步、C-J8 第 2 步）之前用它：缓存写入在译文上屏之后异步落盘，只等译文出现就刷新，第二次会因为键还没写下而重新请求。

### 6.1 旅程

| 旅程 | 步骤与用户动作 | 可观察结果 |
|---|---|---|
| **C-J1** AI 按词表译 | 1. 设置页「添加词条」：attention → 注意力，所有网站，zh-CN。2. 打开 `[fixture]` 页面（含 "Attention is all you need" 和一段不含词条的文字），点悬浮球整页翻译 | 1. 列表出现这一条，用量变成 1 / 300。2. mock 收到的 system prompt 里 GLOSSARY 块含 `- "attention" → "注意力"` 这一行（§3.5 的行式，勘-1）；不含词条的那一批没有 GLOSSARY 块 |
| **C-J2** 站点范围 | 1. 加两条同原文的词条：一条限本页主机、一条所有网站，译文不同。2. 再加一条限别的主机。3. 整页翻译 | 同原文只发站点那一条（§0.1-5 的胜者规则）；限别的主机的那条不发 |
| **C-J3** 内置引擎 | 1. 引擎选内置（`stubBuiltinTranslator`）。2. 整页翻译。3. 改用 `{dropPlaceholders: true}` 再翻一次 | 2. `__builtinTexts` 里词条原文被 `{{n}}` 占住，页面译文里原文原样出现；内置分支不带任何附加说明。3. 控制台只打一次占位丢失日志；不带词表重试一次；页面仍有译文；`stats().placeholderLosses` 为 1 |
| **C-J4** CSV 与整份导入导出 | 1. 卡片「导出 CSV」。2. 改一行、加一行后「导入 CSV」。3. 点「导入」。4. 导入一份第 3 行坏掉的 CSV。5. 设置页整份导出，清空词表，再整份导入 | 1. 文件带 BOM、CRLF、五列表头。2. 预览「将新增 1 条、替换 1 条」。3. 存储与预览一致。4. 显示「第 3 行无效，没有导入任何内容。」，存储不变。5. `glossary` 一节往返后条目逐字段相同，预览行数字对得上 |
| **C-J5** 缓存与 generation | 1. 整页翻译一次，刷新后再翻；再刷新一次，留一张本次加载没整页翻过的页（勘-4：悬停不接已整页翻过的块）。2. 不刷新，在设置页加一条命中本页的词条。3. 同页再翻；悬停同一段；字幕同一句 `[fixture]` | 1. 第二次 mock 不再收到请求（命中缓存）。2. 页面的 generation 递增。3. mock 收到新请求且带新词条；悬停和字幕都不拿旧缓存 |
| **C-J6** 领域与上下文 | 1. 领域选「法律」，开「附带页面上下文」。2. 整页翻译。3. 站点规则把本站领域设为「医学」，再翻。4. 输入框翻译一句。5. 关上下文再翻 | 2. prompt 含法律的 DOMAIN 句，PAGE CONTEXT 含标题和前后文，各不超过 300 字；`AutoStats` 的已发字数多出上下文那部分。3. DOMAIN 句换成医学；存储里这条规则 `v: 2`。4. 输入框的请求没有 PAGE CONTEXT。5. 没有 PAGE CONTEXT |
| **C-J7** 划词加入术语表 | 1. 在页面上划 "Transformer"，卡片出译文。2. 点「加入术语表」，把译文改成「变换器」，保持「仅本站」，保存。3. 点「重译」 | 1. 按钮露出；J-D9 的动作行几何断言照样通过。2. 按钮变成「已加入」，动作行几何不变（J-D9 点击清单）；存储里多一条 `h` 为本页主机的词条；同原文再加一次显示「已更新已有词条」。3. mock 的 prompt 含这一条 |
| **C-J8** iframe | 1. `[fixture]` 顶层页嵌一个跨源 iframe，iframe 里有命中词条的段落。2. 整页翻译，刷新再翻 | 2. iframe 的请求经顶层执行，prompt 含词表（子帧自己不建镜像）；刷新后第二次不再发请求（走 `via: 'cached'`） |

### 6.2 承诺即断言

界面上每句承诺行为的文案都对应一条要执行的断言，只比对字符串不算：

| 文案 | 断言 |
|---|---|
| 「AI 翻译按它译」 | C-J1：prompt 里带这一条 |
| 「内置翻译保持原文不动」 | C-J3：内置译文里原文原样出现 |
| 「将新增 N 条、替换 M 条」 | C-J4：导入后存储的增量等于 N、M |
| 「没有导入任何内容」 | C-J4：坏文件导入后存储逐字节不变 |
| 「已加入」/「已更新已有词条」 | C-J7：存储里有这一条；重译时 prompt 带上它 |
| 「站点规则里设了领域的网站，以规则为准」 | C-J6 步骤 3 |
| 「翻译整页时还附上前后各一小段文字」「多用一些额度」 | C-J6 步骤 2：上下文长度上限、已发字数增量 |
| 「自动翻译只附标题」 | `prompt-domain-context-guards.spec.js`：自动路径（含一轮多批）每批的上下文只有标题，额度按实发上下文计 |
| 悬停、划词卡片「只附标题」（本表 §4.3） | `prompt-domain-context-guards.spec.js`：不刷新改规则后悬停与卡片只带标题 |
| 隐私政策「内置翻译不发送这两样」 | C-J3：内置分支收到的只有占位后的原文 |

### 6.3 单测

| 模块 | 钉住的行为 |
|---|---|
| `shared/text-markers.js`（`test/unit/text-markers.test.mjs`，修-11/12） | `segments` 拼回原文；`placeholderPattern()` / `markerPattern()` 每次是新实例，交错 `exec` 互不干扰；`markerPattern().flags` 含 `g` 与 `i`；`splitSafe` 不切开 `{{n}}`；`debrisScrubber` 的四组语义用例（自有标签、1111/1213 拆分、拆不开不动、5000 位数字线性）；扫描：`{{` 与标记的正则字面量只在本文件和 `test/` 里；加载顺序：manifest（:118 之前）与 `PAGE_TRANSLATION_MODULES`（:83 之前）都排在 `content/content-language.js` 前 |
| `shared/glossary.js` | `normalizeSource`、`dedupeKey`、`validateEntry`（长度、`l`、`h`）、`decode`（坏条目和 `v > 1` 返回 null）、`pick`（作用域与同原文胜者） |
| `shared/glossary-csv.js` | 引号、逗号、字段内换行、BOM、CRLF；两列格式；跳过表头；全有或全无并报第一个坏行号；`previewImport` 的 added/replaced 与超额 |
| `background/glossary-host.js` | 照 `test/unit/custom-rules-host.test.mjs`：只回 `GLOSSARY_FOR_HOST`，别的消息返回 `undefined`；主机取 `sender.url`；只回全局加本站条目 |
| `content/engine/glossary.js` | W 类字母才要词边界，中日韩不要；大小写两种模式；最左最长、不重叠；只在 `text` 片段里匹配；扫描：不出现 `(?i` |
| `shared/prompt-addenda.js` | 超限和多余字段都抛；`general` 不发句子；附加说明块排在数学规则之前；`PROMPT_DELIMITER_RE` 那句话不出现在块里 |
| `sendToModel` | 超过 60 条拆成多份、依次发、各自计费、第一份失败原样返回 |
| 内置引擎 | 至多 20 个占位；原样回声返回原文；`PlaceholderLossError.lost`；词表占位丢失重试一次并计数，只丢数学占位直接抛；检测语言用原文 |
| 缓存 | `FACTORS` 有八个；`addenda` 变了键就变；`buildKey` 遇到函数抛 `TypeError` |
| `ctx.translationProfile` | 设置键、词表签名、`customRules.onProfileChange` 三种来源都让 generation 递增；悬停和字幕的键带 generation |
| `shared/custom-rules.js` v2（修-B） | `v: 2` 带 `domain` 合法；`v: 2` 不带 `domain` 拒；`v: 3` 拒写、读时跳过（:89、:205 改）；`normalizeRule` 无 `domain` 时仍写 `v: 1` |
| `custom-rule.js` | `current().domain`、`domain()`、`onProfileChange` 只在引擎或领域变化时回调 |
| 设置迁移 | `glossary` 一节；`COLLECTION_REFUSALS` 五行映射；`buildEnums` 的领域来自 `PromptAddenda.DOMAINS`（扫描：没有抄出来的领域列表） |
| 接线 | `textsChars(` 只留在 `shared/auto-stats.js`（`test/unit/auto-translate-wiring.test.mjs` :388 的断言随之改）；已发字数算上上下文；`GLOSSARY_WRITE` 在 `STORAGE_WRITERS` 里 |
| 加载顺序 | manifest、`options.html`、`engine-harness.mjs` 的 import 表（:95-100）、`PAGE_TRANSLATION_MODULES`（:47）都含全部新文件且顺序一致；`site-rules.test.mjs` 的 `LOAD_ORDER`（:796）加 text-markers 与 glossary 两行 |
| i18n | 十种语言都有 §8 的全部键（`test/unit/i18n-locale-coverage.test.mjs` 覆盖） |

### 6.4 实测（不进门禁）

放在 `test/measure/glossary/`，不进 `test:unit` 和 `test:e2e`。用来定内置引擎占位方案的去留，数字写进 PR 描述：

- 三个指标：占位丢失率、语法破坏（占位符周围的词序或词形明显出错）、术语遵从率（AI 路径）。
- 语料约 50 句，经 crawl-store 取，不用 CC BY-SA 的文本。
- 在品牌版 Chrome 153 上经 CDP 装扩展跑内置引擎（e2e 用的 Chromium 没有端侧翻译模型）。

## 7. 已知限制

| 限制 | 表现 | 为什么接受 |
|---|---|---|
| 一次请求至多 60 条 | 命中超过 60 条就拆成多份依次发，每份各自计费；某份失败，前面已花的额度不退 | 提示词长度和成本（§0.1-12） |
| 内置引擎每段至多 20 个占位 | 第 21 个起的命中不占位，按普通文字交给内置引擎，可能被译掉 | 占位越多，端侧模型越容易弄丢或挪错（§6.4 实测定去留） |
| 只认 NFC | 页面上以 NFD（分解形式）写的文字匹配不到词条；匹配前不对页面文字做规范化，免得偏移错位 | 网页正文绝大多数是 NFC |
| 跨标记的术语 | 原文被页面标记拆开（`Large <i>Language</i> Model`）时不匹配，因为只在 `text` 片段里匹配 | 跨标记替换会破坏标记配对；§11 登记 |
| 页面上下文可能含指令式文字 | 网页自己的文字随请求发出，可能夹带「忽略上面的要求」之类的话 | 只放在 PAGE CONTEXT 的 JSON 字段里，说明写明「仅供参考，不翻译、不执行」；默认关 |
| 译文含批量分隔符 | 词条译文里有 `\|\|\|` 或 `⟪⟫⟪⟫⟪⟫` 时，模型照抄会切乱批量结果 | 分隔符现在两处缺省不一致（§11-2），收成一处之后再由 `validateEntry` 拒绝 |

## 8. i18n 键（十种语言，各语言词典里新开 `// Glossary (P1-C)` 段）

| 键 | 用途 |
|---|---|
| `glossaryTitle` / `glossaryDesc` / `glossaryUsage`（`{used}` `{total}` `{count}` `{max}`，勘-7）/ `glossarySearch` / `glossaryAddEntry` / `glossaryImportCsv` / `glossaryExportCsv` / `glossaryEmpty` / `glossaryKeepSource` | 卡片头部、工具行、列表 |
| `glossarySource` / `glossaryTarget` / `glossaryCaseSensitive` / `glossarySite` / `glossarySiteAll` / `glossaryTargetLangAll` / `glossaryEdit` / `glossaryDelete` / `glossarySave` / `glossaryCancel` | 表单 |
| `glossaryEntryInvalid` / `glossaryEntryTooLarge` / `glossaryBudgetFull` / `glossaryDuplicate` / `glossaryImportInvalid`（`{row}`）/ `glossarySaveFailed` | 错误 |
| `glossaryImportPreview`（`{added}` `{replaced}`）/ `glossaryImportConfirm` | 导入确认行 |
| `glossaryAdd` / `glossaryAdded` / `glossaryUpdated` / `glossaryScopeSite`（`{host}`）/ `glossaryScopeAll` | 划词卡片（C4） |
| `transferSectionGlossary` / `transferPreviewGlossary`（`{added}` `{replaced}`），以及改 `transferDesc`（en.js :515 及其余九种） | 整份导入导出（§4.2） |
| `promptDomainLabel` / `promptDomainHint` / `promptDomainGeneral` / `promptDomainTech` / `promptDomainAcademic` / `promptDomainLegal` / `promptDomainMedical` / `promptDomainFinance` / `promptDomainGaming` / `promptDomainFiction` / `promptDomainNews` | 领域下拉（C3） |
| `aiPageContext` / `aiPageContextHint` / `customRuleDomain` / `customRuleDomainInherit` | 上下文开关；规则表单的领域下拉（C3，挨着 en.js :600 的 `customRuleEngine`） |

给模型看的领域句子和 GLOSSARY / DOMAIN / PAGE CONTEXT 块是英文常量，写在 `shared/prompt-addenda.js`，不进 i18n。

## 9. 新文件与分批

| 文件 | 批 | 加载位置 |
|---|---|---|
| `shared/text-markers.js` | C1 | SW import 表；manifest（`content/content-language.js` :118 之前）；`options.html`（:954 之前）；`engine-harness.mjs`（:95-100 内、languages 之前）；`PAGE_TRANSLATION_MODULES`（:83 之前）；`onboarding/onboarding.html`（引擎之前，勘-3） |
| `shared/prompt-addenda.js` | C1 | SW；manifest；`options.html`；`onboarding/onboarding.html`（勘-3） |
| `shared/glossary.js` | C1 | SW（`sync-collection.js` :20 之后）；manifest（`custom-rules.js` :107 之后）；`options.html`（:945 之后）；`onboarding/onboarding.html`（连同它加载时要的 `site-rules-builtin` / `storage-writer` / `site-rules` / `sync-collection`，勘-3） |
| `background/glossary-host.js` | C1 | `background.js` import（:51 旁） |
| `shared/glossary-csv.js` | C2 | SW（导入时重新解析）；`options.html` |
| `content/content-glossary.js` | C1 | manifest（`content-bootstrap.js` :113 之后、`content-language.js` :118 之前） |
| `content/engine/glossary.js` | C1 | manifest、`options.html`、`engine-harness.mjs`（引擎之前） |
| `content/engine/addenda.js` | C1 | 同上 |
| `options/options-glossary.js` | C2 | `options.html`（:979 之后、:985 之前） |
| `options/css/glossary.css` | C2 | `options.html` 的 `<head>`（:17 的 `<link rel="stylesheet">`，勘-8） |
| `test/unit/text-markers.test.mjs` | C1 | 取代 `test/unit/markup-marker-regex.test.mjs`（同批删除） |

- 没有新的顶层目录，打包脚本不用改。`test/measure/` 在 `test/` 之下，不进包。
- 1k 行：`content/content-translation-engine.js` 现在 859 行。占位保护与还原放进 `content/engine/glossary.js`，附加说明的组装与按 60 条拆份放进 `content/engine/addenda.js`，引擎文件只留 `sendToModel` 的接线，合入后不得超过 1000 行。`content/page/collect.js` 993 行，§3.9 从它搬走 `MARKUP_MARKER_RE`、`stripPlaceholders` 和两处拼接，只减不增。`options/options.js` 871 行，C3 只加字段，卡片逻辑在自己的文件里。`shared/custom-rules.js` 427 行，修-B 加不到 20 行。
- 四批串行，每批按逻辑拆成若干本地提交（批与批不交错），都进 `feat/p1-c-glossary` 这一个 PR，合入时 squash；每批 diff 以约 1500 行为上限参考。每批的文件集互不相交（勘-3）：C1 = shared/ 四个新文件 + 引擎两个新文件 + `content-glossary.js` + `glossary-host.js` + §3.9 表里的迁移（含 `batch.js` 的 `splitSafe`）+ 本节加载表里的装载清单（`options.html`、`onboarding/onboarding.html`）+ `background.js`/`ai-translate.js`/`prompts.js`/`translation-cache.js`/`content-translation-cache.js`/`frames/*`/`frame-relay.js`/`hover/blocks.js`/`captions/translate.js`/`content-bootstrap.js` + 隐私政策 §三/§六；C2 = `glossary-csv.js`、`options-glossary.js`、`options.html` 的术语表卡片、`options-transfer.js`、`settings-transfer.js`、i18n；C3 = `custom-rules.js`、`custom-rule.js`、`options-custom-rules.js`、`options.js`、`default-settings.js`、`settings.js`、`batch.js` 的上下文取材（§4.3，修-18）、`content-popup.js` 的 `translateText`、隐私政策 §一；C4 = `content-popup.js` 的动作行、`popup.css`、`top.js` 的 `host`。`content-popup.js` 和 `top.js` 在 C3/C4 各碰一次不同区域，C4 在 C3 之后 rebase 无冲突。

## 10. 门禁（原文照抄，`<W>` 是 worktree 的绝对路径）

```bash
npm --prefix <W> run test:unit > <log> 2>&1; echo "GATE unit exit=$?"
npm --prefix <W> run test:e2e > <log> 2>&1; echo "GATE e2e exit=$?"
```

- 按 `GATE ... exit=` 那一行和日志里 ✘ 的个数判定，不接 `tail`、`head` 之类的管道。
- e2e 全量约 18 分钟，超过工具的超时，用 `nohup sh -c "...; echo \"GATE e2e exit=\$?\" >> <log>" > /dev/null 2>&1 &` 脱离后台跑，跑完读日志。
- 已知偶发：`test/e2e/selection-popup-pronunciation.spec.js` 连真实的 `https://example.com`，网络抖动时 `page.goto` 报 `net::ERR_ABORTED`。遇到时单独重跑这个文件三次，全过就记为偶发并附日志。
- 每批验收线：C1 单测全绿且 `text-markers.test.mjs` 的扫描零命中、C-J1/C-J2/C-J3/C-J5/C-J8 一致；C2 C-J4 一致；C3 C-J6 一致且 `custom-rules.test.mjs` 翻过来的两条通过；C4 C-J7 与 J-D9 一致。

## 11. 登记待办（本期不做）

1. `content/content-translation-cache.js` :16 的 `PROFILE_KEYS` 不含服务商：只换服务商、端点和模型不变时，旧缓存照样命中。
2. 批量分隔符两处缺省不一致：`background/background.js` :359 的 `handleBatchTranslateFast` 缺省 `'|||'`，`background/ai-translate.js` :216 是 `'⟪⟫⟪⟫⟪⟫'`。收成一处之后，`validateEntry` 拒绝含分隔符的词条（§7）。
3. 子帧里的 `ctx.engineChoices`（引擎 :712）和内置模型下载许可按子帧自己算，可能与顶层不一致；划词卡片在 iframe 里「换引擎」时会碰到。
4. 跨标记的术语（§7）。

## 12. 交接缝

1. **`content/page/insert.js`（P0 + #114 的文件）**：`markupDebrisScrubber`（:24-47，字面量 :43）、`placeholderRe`（:75）、锚定式（:124）、`markerRe`（:146）改用 `TextMarkers`（§3.9），:404 的调用点改名 `TextMarkers.debrisScrubber`。行为不变由搬过来的四组语义用例证明（修-11）。
2. **`test/e2e/helpers.js`**：`stubBuiltinTranslator` 加的都是可选项，不传时行为不变，P0 和 P1-A/B 的现有用例不受影响；`PAGE_TRANSLATION_MODULES` 加新文件（§9）。
3. **划词卡片（P0 的 `content/content-popup.js`）**：C4 守 J-D9 的几何断言（含点击后改字那一次，修-13）和 `fitLabel` 的定宽规矩（§5），不改换引擎和复制两个按钮的行为。
4. **P1-B（已合入）**：C1 用 `SyncCollection`、`ctx.syncMirrors`、`StorageWriter`、`SiteRules.hostMatches`，SW 侧照 `custom-rules-host.js` 的模块模式（修-2）。C3 往 `options/options-custom-rules.js` 加领域字段、往 `shared/custom-rules.js` 加 v2（修-B），`custom-rules.test.mjs` :89/:205 两条随之翻。隐私政策 §三 的词表一行与 :137 的规则一行并列。
5. **生效点**：`wantsBuiltin`（引擎 :638）的引擎选择不动。`sendToModel` 只包住 :700-703 的额度门和出口，内置分支在 :562/:585 接 `withGlossary`。
6. **设置迁移（P0-F 的函数体）**：C2、C3 只按 B§12.4 的接口加行和加 `domains` 参数，不改 `pickExport`、`valueOk`、`validateSettings` 的逻辑。
