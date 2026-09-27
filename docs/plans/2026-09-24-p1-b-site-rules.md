# P1-B 用户站点规则：翻译范围 / 排除 / 保留原文、自定义 CSS、按站点引擎、页内拾取器、导入导出

- 日期：2026-09-24
- 基线：`origin/main@a99435d`（manifest 1.4.0）；分支 `feat/p1-b-site-rules` 已 rebase 到它上面（D-314）
- 行号口径：全部对到 `origin/main@a99435d`（D-314 重新对锚：P1-A #107、P0-D #111 已合入，原来的 A1 / A2 / A / D 标注取消；`scope.js` 的注释 #107 已写好、悬浮球菜单已自己量高度、popup 拆成 `popup.js` / `popup-display.js` / `popup-pdf.js` 三个文件，相应各行已改）
- 所属：P1 功能对标回合（台账 D-291），本设计的自决登记为 D-296
- 修订 2026-09-25（台账 D-302、D-303），为 P1-C 术语表铺路，同时对齐 P0-D 的引擎契约：
  - 抽出 `shared/sync-collection.js`（§0.1-20、§2.6）；
  - `SiteRules` 补导出三个模式助手（§1）；
  - 站点引擎是钉住，永不回退（§0.1-11、§3.7）；
  - §2.1 加项数列；
  - D-303：钉住落在谓词 `isBuiltinSelected` / `fallbackAllowed` 上，不进 `pinnedEngine`；popup 和字幕绕过谓词的三处直读收口；本页规则变了要重启自动调度器（§3.6 第 5 步、§3.7）。
- 修订 2026-09-25（台账 D-306），与 P1-C 设计对齐，并接上 P0-F「设置整份导入导出」：
  - 条目 id 只存在键里，值里不带（§2.2、§2.6）；
  - 内容脚本的增量经一张登记表 `ctx.syncMirrors` 转发，bootstrap 不再点名具体集合；P1-C 的词表前缀每个 frame 都登记，只有顶层建镜像（§1、§3.1）；
  - `whenReady()` 的 1500 ms 上限写在 `SyncCollection.mirror` 里，规则和词表共用（§2.6）；
  - 镜像的主机由调用方传入（`mirror({request, host})`），模块里不读 `location`：规则传本 frame 的主机，与 SW 按 `sender.url` 取的一致；词表只在顶层建镜像，传顶层主机（§2.6、§3.1、§12.3）；
  - 写消息的判别字段叫 `kind`，与 StorageWriter 和 site-rules 的 `WRITES` 表同名（§2.4）；
  - 额度检查抽成 `SyncCollection.assertFits`，写入和导入预览共用；导入预览收成一个函数，卡片和整份导入共用；`TRANSFER_SECTIONS` 加 `customRules` 一行；预算格的规则项放在 `syncAutoEngineState()`，不进 `unattendedAiReachable`（§0.1-19、§2.6、§4、§9、§12.4）；
  - §12.4 按 P0-F 合入后的实际接口（`main@8d5e8df`）重写：每个小节多一个 `preview`，`validate` 返回 `{value, accepted, dropped}`；新增小节名、集合拒绝归类表 `COLLECTION_REFUSALS`、原因短语表 `TRANSFER_REASON_KEYS`，以及两个集合共用的行工厂 `collectionSection`；`transferDesc` 随小节一起更新；`mergeImport` 遇到任何一条无效也只抛 `customRulesImportInvalid`（§2.3、§4、§6、§8、§9、§12.4）。
- 交付：一个 PR `feat/p1-b-site-rules`，由两批串行拼装——B1 数据层与页面接线、B2 入口与界面。P1-A（#107，64f2b2a）已合入，本分支已 rebase 到 a99435d。「按站点译文样式」拆成 P1-B·style，等 #105 合入后再做（D-294 #2）

## 0. 结论

今天用户对一个网站只能说「总是翻 / 从不翻」（`siteRules`，`shared/site-rules.js`）。至于这个站点翻哪一块、哪一块别碰，只有内置适配器说了算（`content/page/site-adapter.js:51`），用户改不了。沉浸式翻译允许用户按站点写选择器、写 CSS、换引擎，还能在页面上直接点选。

这一轮在设置页加一张「站点翻译规则」卡。每条规则由两部分组成：一组 `host[/path-glob]` 匹配模式，加上下表字段中的至少一个。匹配语法沿用 site-rules 已有的模式助手：主机按后缀匹配（覆盖子域），主机里不许出现 `*`，路径可以带 glob。

- **入口**有两个：设置页的编辑器；页内拾取器（悬浮球菜单一项，外加 popup 一个按钮）。
- **存储**：`chrome.storage.sync` 里每条规则一个键 `customRule:<id>`，跟着账号同步；另提供 JSON 导出和导入。
- **解析**：页面侧只有一个解析器 `shared/custom-rules.js`，用户规则优先于内置适配器；`SiteRules.decide()` 一行不改。

| # | 能力 | 边界（刻意不做的） |
|---|---|---|
| 1 | **翻译范围 / 排除 / 保留原文**：include、exclude、keepOriginal 三组选择器 | 同一 URL 命中多条规则时不叠加，只取一条（§0.1-5）；内置规则表的保留原文用户撤不掉 |
| 2 | **自定义 CSS**：作用于本站页面，用 constructable stylesheet 注入 | 不进 shadow DOM；凡是会发网络请求的写法一律拒绝 |
| 3 | **按站点引擎**：可选内置 / 我的 AI / 跟随全局；选定即钉住，不回退 | 不能选模型或配置档（归 P1-D）；只管两个引擎都能处理的请求（§0.1-11） |
| 4 | **页内拾取器**：悬停描框、点选、「↑上一层」、选择器可编辑、实时显示命中数 | 只在顶层 frame 工作；没有撤销，删规则去设置页 |
| 5 | **设置页**：规则列表、编辑器、用量表、导出/导入 | 没有规则市场 |
| 6 | **一个解析器，用户优先** | `SiteRules.decide()` 不变，自动翻译的「总是 / 从不」判断照旧 |

### 0.1 自决（台账 D-296 已登记，此处给依据）

| # | 裁定 | 依据 |
|---|---|---|
| 1 | **键布局**：每条规则单独一个 sync 键 `customRule:<id>`。`siteRules` 不动。不设索引键，读全部规则一律用 `get(null)` 再按前缀过滤 | sync 单项上限 8 KiB（JSON 加键名），把所有规则塞进一个数组键很快就会撞顶。sync 按键合并，两台设备各改各的规则互不覆盖。索引键在两台设备同时新增规则时会互相覆盖，结果是规则还在、却列不出来。最低支持的 Chrome 116 没有 `getKeys()`（Chrome 130 才有），只能用 `get(null)` |
| 2 | **额度**：单条 ≤ 6 KiB（按存进去的形状计：键名加上不带 `id` 的值，§2.6 `usage`），全部规则合计 ≤ 24 KiB 且 ≤ 50 条。检查只有一份 `assertFits`（§2.6），SW 写队列和导入预览都调它；超额就拒绝，不做截断 | sync 总额 100 KiB，要分给设置、`siteRules`、询问计数、P1-C 词表和 P1-D 配置档，分法见 §2.1 额度表。截断会在用户不知情时丢掉他写的选择器 |
| 3 | **抽出 `shared/storage-writer.js`**（`globalThis.StorageWriter`）。`create({type, writes, errors})` 返回 `{applyWrite, request}`。它统一持有 `IN_SERVICE_WORKER` 判断、每个 writer 一条队列、`itemBytes`、`ITEM_BUDGET = 6 * 1024`（从 site-rules 的 `MAX_ITEM_BYTES` 搬过来）。site-rules、auto-stats、custom-rules 三家共用 | 「SW 单写者队列」这是第三次出现。前两份（`shared/site-rules.js:413-438/:564-585`、`shared/auto-stats.js:166-176/:222-247`）已经是同一段代码抄了两遍，再抄第三遍正是 CLAUDE.md「Shipping Changes」第 2 条说的漂移。两家对错误的处理本来就不同，所以做成参数：site-rules 出错时抛出，auto-stats 吞掉错误回 null |
| 4 | **读取**：内容脚本不调 `get(null)`，也不镜像全部规则。SW 应答 `CUSTOM_RULES_FOR_HOST`，host 取 `sender.url`。之后内容脚本只吃 `storage.onChanged` 里 `customRule:` 键的增量，由 bootstrap 经登记表 `ctx.syncMirrors` 转来（§1）。设置页读全部 | 沿用只读需要的键的既有做法（`content/content-bootstrap.js:129-131` 只镜像设置键）。一个页面只关心自己主机的那几条规则 |
| 5 | **胜出规则**：同一 URL 命中多条时只取一条。先比命中模式串的长度，最长者胜；一样长时取 `updatedAt` 较新的；再一样取 id 较小的 | 叠加的语义用户既看不见也猜不到：两条规则的 include 该取并集还是交集？CSS 谁在前？「最具体的赢」是 CSS 优先级、路由表、site-rules 共同的直觉 |
| 6 | **与内置适配器合并**：atomic 只来自内置；exclude 只来自用户；keepOriginal = 内置 ∪ 用户；include、CSS、引擎只来自用户 | atomic 是内置适配器针对特定 DOM 调出来的整块翻译，不向用户开放。keepOriginal 取并集，保证内置规则表保留原文的那些元素（作者名、时间戳、票数）不会被一条用户规则意外放开：用户撤不掉内置的 |
| 7 | **exclude 与 keepOriginal 的分工**。exclude 表示不翻译、也不送出：命中块则跳过整块；命中块内的行内元素，则把它的文字从原文里拿掉。keepOriginal 表示不翻译、但原样保留：命中块则跳过整块，且在 translate judge 之前判定；命中行内元素，则按 `translate="no"` 处理，送出占位符，译文里原样出现 | 照搬沉浸式翻译 `excludeSelectors` / `stayOriginalSelectors` 的分工，用户从那边迁过来的规则语义一致。行内保留复用 A2 的 notranslate 占位符（collect.js:710-714），不另造机制。块级 keepOriginal 在 judge 之前判，所以页面里的 `translate="yes"` 重开不了它：用户规则优先于页面声明。内置规则表按 keepOriginal 语义（D-315）：字段名 `keepOriginalSelectors`，作者名、时间戳、票数不翻译，但也不从译文里消失 |
| 8 | **范围阶梯**，从高到低：临时「整页」覆盖 → 用户 include（至少命中一个已渲染元素）→ 设置为 'page' 或 `matchBuiltin` 命中 → 'main'。include 零命中时不缓存结果 | 「翻译整个页面」是用户当下的明确动作，应当压过一切。include 是用户专门为这个站点写的范围，比全局设置和内置规则更具体。零命中时往下回落：站点改版后选择器失效，不能让整页一个字都不翻。零命中不缓存：SPA 的正文常常晚于首轮渲染 |
| 9 | **CSS 注入方式**：只用 constructable `CSSStyleSheet`，挂到 `document.adoptedStyleSheets`，没有 `<style>` 退路（D-297 修订 D-296 第 6 条）。不用 `chrome.scripting.insertCSS` | `insertCSS` 需要 `scripting` 权限，本轮不加新权限。A2 已经用过同一手法（`content/page/shadow.js` 的 `installStyle`，整合批同样删掉了它的 `<style>` 退路）。adopted sheet 排在文档样式表之后，同等特异度时用户 CSS 胜过页面样式表。译文节点带着行内样式，清单按 `content/page/insert.js` 的实际写入数（B2 终态）：<br>• 普通块（无真公式，`insert.js:506`）：`baseStyle`（:424-433）的字号、字体、字重、行高、对齐、颜色、字距、opacity 0.85，外加 padding（0，四边）和 box-sizing；<br>• slot 元素内插（:555）：`baseStyle` 加 display:block、margin 0、padding 0、box-sizing；<br>• 含真公式的块（:497）：只有 opacity 0.85；<br>• 水平 flex 那一支（:448-462）另列：字号 0.85em、字体、字重、行高、颜色、字距、opacity 0.7、display:inline、margin 0、padding 0；<br>• 兄弟位置的译文（`!placement.inside`，:532-535）另有自定义属性 `--ai-translator-pair-margin-top`（不带 `!important`）和带 `!important` 的 margin-bottom；<br>• 原文前面有图标缩进时，`applyTextInset`（`content/content-language.js:84`）写带 `!important` 的起始边 padding；水平 flex 那一支同样写带 `!important` 的起始边 margin 4px（:462）。<br>不带 `!important` 的那些，用户 CSS 要改必须加 `!important`（设置页 J-4 就是这么写的）；带 `!important` 的三项（兄弟译文的 margin-bottom、图标缩进的起始边 padding、flex 译文的起始边 margin）用户 CSS 怎么写都改不了，编辑器提示 `customRuleCssHint` 照实写了这三项。只留一条路径：最低版本 Chrome 116 上两个 API 都在，构造或挂载失败只可能来自页面环境异常，这时应当打日志让它被看见，而不是悄悄换一条没人测的路 |
| 10 | **CSS 清洗**。原文和去掉注释后的文本各查一遍（不区分大小写），出现任何一个就拒绝，注释里的也算：`url(`、`image-set(`、`image(`、`cross-fade(`、`src(`、`attr(`、`@import`、`@font-face`，以及任何反斜杠。长度 ≤ 4096 字符。SW 写入时查一遍，内容脚本应用前再查一遍。只拒绝、不改写 | 规则会经 sync 和导入文件流转，导入的文件可能出自别人之手。CSS 里一切能发请求的构造都能把页面信息带给第三方，「属性选择器 + 背景图」就是已知的 CSS 外泄手法。反斜杠转义能拼出任意关键字，所以一律拒绝。查去注释后的文本是为了防 `u/**/rl(` 这种拼接；只查去注释后的文本，会被字符串里的 `/*` 绕过（D-315），所以原文也查。只拒不改，保证用户看到的就是实际生效的。内容侧再查一遍，是因为 sync 里的数据不一定都经过本机 SW。代价是 `content: "\201C"` 这类合法写法也会被拒，提示文案里要说明 |
| 11 | **引擎覆盖是钉住**（D-302 修订）。<br>• 手动、自动、无人值守三类请求都认，`effectiveEngine` 也反映覆盖结果。<br>• 优先级：`message.engine`（P0-D）> 规则的 `engine` > 两个全局开关。<br>• 钉住的引擎永不回退。规则选内置而内置不可用时，按内置报错；即使 `engineFallback: 'allow-ai'`，也不转 AI。规则选 'ai' 但没配 Key 时，走现有的「没配 Key」路径。<br>• 只管两个引擎都能处理的请求（TRANSLATE / TRANSLATE_BATCH / TRANSLATE_BATCH_FAST）。钉内置时，查词退化成没有音标的普通翻译，和全局选内置时一样。内置处理不了的请求类型本来就只走 AI，规则不影响它们。<br>• OCR 的识别步骤不归规则管；识别出的文字经 TRANSLATE 翻译，跟随钉住的引擎。<br>• 预算闸的代码不改，只改它上面的注释。<br>• **落点在谓词**（D-303）：`isBuiltinSelected` 和新的同步谓词 `fallbackAllowed` 先问站点，`pinnedEngine` 和它那行抛错都不动。popup 和字幕绕过谓词直读设置的三处，以及现有裸调用扫描漏过的语言包两处，一并收口（§3.7） | 引擎是按站点的偏好，用户说「这个站点用 AI」时，不会区分是点出来的翻译还是自动的。自动和无人值守请求照旧带 `auto` / `unattended` 标记，过闸时照样扣额度；只是能走到闸前的组合多了一种，注释跟着改。<br>给站点钉内置，是为了省 AI 额度，或者不让这个站的文字进第三方模型；回退到 AI 恰好违背这两个目的。<br>「内置处理不了就抛错」只针对显式的 `message.engine`：那是调用方契约检查，不是选引擎。规则是把设置收窄到一个站点，设置从来不管只有 AI 能处理的请求类型 |
| 12 | **frames**：`engineOverride` 加进顶层指令，子 frame 照单继承。选择器与 CSS 按子 frame 自己的 URL 解析 | 这是 A1 偏差 #7 附带的约束：子 frame 本地回答 `effectiveEngine` / `isActive`。有了按站点引擎后，子 frame 必须跟随顶层 frame 的规则，否则一个页面会出现两种引擎。选择器和 CSS 作用于 DOM，只对子 frame 自己的文档有意义。实际执行本来就在顶层（A1 偏差 #15） |
| 13 | **规则变更即时生效**（≤ 1 s，不用重载） | 拾取器的价值就在「点完立刻看到」。要重载才生效的编辑器，用户会以为没保存。增量去抖 150 ms 再加一轮收块，远低于 1 s |
| 14 | **拾取器生成的选择器**只要求在它自己的 root 里唯一。优先级：id > 稳定的 `data-*` > 标签 + 非哈希类名（`isVolatileClass` 判定）> `nth-of-type` 链，最多 5 层 | 规则会存下来长期复用，所以要挑最不容易随站点构建变化的写法。id 和 `data-*` 是站点作者手写的，最稳。CSS Modules、styled-components 生成的哈希类名每次构建都会变，不能用。`nth-of-type` 链最脆弱，排在最后，并限制在 5 层以内 |
| 15 | **入口**：悬浮球菜单加一项，popup 加一个按钮；不加快捷键 | 拾取是低频动作。Chrome 对 `commands` 的建议键最多只给 4 个，已用了 Alt+A 和 A2 的 Alt+W，剩下的留给更高频的功能 |
| 16 | **JSON 格式**：`{format:'blab-site-rules', version:1, exportedAt, rules}`。导入按 id 合并，全有或全无；额度按合并后的结果检查；写入用一次多键 `set`；导入的规则 `updatedAt` 一律记为当前时间。文件里每条规则带 `id`（`collect` 从键上取回），存储里的值不带（§2.2） | 有 `format` 和 `version`，导入时一眼就能拒掉别的文件。按 id 合并，「导出 → 改 → 导入」就是幂等的。全有或全无，避免导入一半后用户不知道哪些进去了。多键 `set` 只算一次写（sync 每分钟上限 120 次）。`updatedAt` 取当前时间，是让刚导入的规则在平局时胜出，符合用户预期 |
| 17 | **译文样式**（style）挪到 P1-B·style | 译文样式要在所有 frame 生效，得等 #105 的 `ctx.applyTranslationDisplay()` 覆盖所有 frame（D-294 #2）。「自己写样式」的需求，本轮的自定义 CSS 已经覆盖 |
| 18 | **切批**：B1 在前、B2 在后，串行，合成一个 PR | B1 是数据层和页面接线，没有界面，用夹具预置规则来验证。B2 是全部入口和界面。两批改的文件几乎不相交，唯一交集是悬浮球，且改的是不同 hunk。但 B2 的旅程依赖 B1 的行为，所以只能串行。B1 单独上线用户什么也看不见，所以不单独开 PR |
| 19 | **「会花钱」的确认统一成一个助手** `confirmUnattendedAiSpend(messageKey)`，它是全设置页唯一的 `window.confirm`。两个调用方：`onAutoEngineChange('autoTranslateEngineAiConfirm')`；规则编辑器里引擎新改成 'ai' 时（`'customRuleEngineAiConfirm'`）。预算格的启用状态由 `syncAutoEngineState()` 在 `unattendedAiReachable(...)` 之外并上 `customRulesUseAi()` 得出，规则项不并进这个谓词（D-306）。导入不弹确认框 | 一条规则把某站点的自动翻译改成 AI，和把全局自动引擎改成 AI，花的是同一笔钱，确认也该是同一种形状。现有测试（`test/unit/auto-cost-gate.test.mjs:118`）只钉住一处 `window.confirm`；抽成助手后，测试改为钉「只有一个 `window.confirm(`，两个调用方」，以后第三个调用方也绕不开它。导入时，预览里的 AI 提示加上用户点「导入」这个动作，就是同意；设置整份导入（P0-F）也按这一条，前提是整份预览里出现同样的 AI 提示（§12.4）。P0-F 把 `unattendedAiReachable` 改成只吃一个设置对象，整份导入的预览拿它比较导入前后的设置；规则项要是并在里面，规则里已有 AI 时，设置小节的提示就永远不会出现 |
| 20 | **抽出 `shared/sync-collection.js`**（`globalThis.SyncCollection`，D-302 修订）。「一条一个 sync 键、按主机取、增量跟随」的集合只有这一份实现，custom-rules 建在它上面，P1-C 词表也建在它上面。接口见 §2.6 | 规则和词表的读、写、缓存、增量这一整套逐字相同。只要写第二遍，就是第 3 条说的第三次抄写。B1 本来就要写这套逻辑，先写成参数化的，P1-C 就不用再抄 |

## 1. 现状（file:line）

| 位置 | 现状 | 本轮 |
|---|---|---|
| `shared/site-rules.js:69/:84/:101/:108/:138` | `normalizeHost` / `hostMatches` / `splitPattern` / `patternMatches` / `validPattern` 覆盖 `host[/path-glob]` 模式的全部判断；`validPattern` 拒绝主机里带 `*` | B1：sync-collection 和 custom-rules 通过 `SiteRules` 的导出直接复用，不复制。今天的导出表（`:638-656`）只有 `normalizeHost`，要补上 `hostMatches`、`patternMatches`、`validPattern`。P1-C 词表也用 `hostMatches` |
| `shared/site-rules.js:226-237` | `matchBuiltin()` | 不改 |
| `shared/site-rules.js:413-438`、`:564-585` | SW 单写者队列：`IN_SERVICE_WORKER`、`writeQueue` / `enqueue`、`MAX_ITEM_BYTES = 6 * 1024`、`itemBytes`、`WRITES`、`applyWrite`、`request`（`:578-585`，出错即抛） | B1：改用 `StorageWriter.create({errors: 'throw'})` |
| `shared/auto-stats.js:166-176`、`:222-247` | 同一套队列的第二份抄本；`request` 吞掉错误回 null | B1：改用 `StorageWriter.create({errors: 'swallow'})` |
| `background/background.js:134-151` | `onMessage` 里两段 if：`SITE_RULES_WRITE` → `SiteRules.applyWrite`，`AUTO_STATS_WRITE` → `AutoStats.applyWrite` | B1：改成一张分派表，新增 `CUSTOM_RULES_WRITE`。`CUSTOM_RULES_FOR_HOST` 在它自己的模块 `background/custom-rules-host.js`（顶层注册 `onMessage`、导出 `handleMessage`，照 `page-coverage.js` 的先例），入口只 `import './custom-rules-host.js';`，单测 `test/unit/custom-rules-host.test.mjs` 守「只认 `sender.url` 的主机」 |
| `background/background.js:10-14`、`background/ai-translate.js:10`、`background/api-client.js:7` | 各 SW 模块各自 import site-rules / auto-stats | B1：三个文件都在这些 import 之前自行 import `shared/storage-writer.js`（SW 模块图深度优先求值，只靠入口 import 一次不够）；`background.js:11` 之后依次 import `shared/sync-collection.js`、`shared/custom-rules.js` |
| `test/unit/site-rules.test.mjs` 约 `:786-803` | `LOAD_LISTS`（background.js、options.html、popup.html）、`LOAD_ORDER` | B1：`LOAD_ORDER` 加 site-rules → storage-writer、auto-stats → storage-writer、sync-collection → storage-writer、sync-collection → site-rules、custom-rules → storage-writer、custom-rules → site-rules、custom-rules → sync-collection；`LOAD_LISTS` 加 `background/ai-translate.js`、`background/api-client.js` |
| `content/page/site-adapter.js:24-68` | `resolveSiteAdapter()` 以 `hostname\npathname` 为缓存键，返回内置规则的 `{atomic, exclude}` 或 null；`:28-43` 的 `usableSelector` 在使用时滤掉无效选择器 | B1：返回 `{atomic, exclude, keepOriginal}`（§3.2），缓存键加上 `ctx.customRules.version`；用户选择器同样过 `usableSelector` |
| `content/page/collect.js:55`、`:293`、`:321` | `closestAcross`（`(el, selector) => ctx.closestComposed(el, selector)`）可跨 shadow 找祖先；块级 exclude；自家 UI 排除列表 | B1：新增 `ctx.ruleForbids`；B2：拾取器根节点加进 `:321` 的列表 |
| `content/page/collect.js:79-81`、`:506-508` | `scope` / `scopeCut` / `allowed`；`scopeCut ? ctx.pageScopeStarts(root, scope) : [root]` | B1：`:506` 的条件改成按 `scope` 判（include 模式没有 cut）；include 模式下 `allowed` = 落在某个 root 里 |
| `content/page/collect.js:710-714` | 行内 notranslate 元素 → 占位符原样保留 | B1：行内 keepOriginal 走同一条路 |
| `content/page/notranslate.js:29/:44` | `ownTranslateDeclaration` / `createTranslateJudge` | B1 不改：keepOriginal 不经 judge，在 collect.js 判——块级走 `ruleBlocksElement`（排在 judge 之前），行内走 `getTextWithMathPlaceholders` 的 `keep` 选项，与 notranslate 占位符同一条路 |
| `content/page/scope.js:49-60` | `pageScopeMode()` 阶梯：临时覆盖 `:56`、设置 `:57`、内置规则 `:58`、默认 `'main'` `:59`；`:50-55` 的注释已按 P1-B 写好（include 是第 2 步，命中记为 `'include'`） | B1：在 `:56` 之后插入用户 include 一档，`@returns`（`:47`）加上 `'include'`；注释不用再改 |
| `content/page/scope.js:101-103`、`:120` | `resolvePageScope()` 的缓存键为 `href\nsetting\noverride`；`invalidatePageScope()` | B1：缓存键加 `ctx.customRules.version` |
| `content/page/scope.js:176-177` | `pageScopeStarts(dirty, scope)` 第一行是 `if (!scope \|\| !scope.skip) return [dirty];` | B1：include 分支放在这一行之前 |
| `content/content-float-ball.js:472-473`、`:563-569` | `showWholePage` 只在 `pageScopeMode() === 'main'` 时为真；菜单先挂上再自己量宽高（`:566` 挂载，`:568-569` 读 `offsetWidth` / `offsetHeight`） | B1：条件改成 `!== 'page'`；B2：加「调整本站翻译区域」一项，不用算高度 |
| `content/content-translation-engine.js:89-95`、`:414-418`、`:437-441` | `isBuiltinSelected(auto)` / `shouldUseBuiltin` / `canFallBackToAI()` / `effectiveEngine({auto})` 只看两个全局开关和 `engineFallback`。`isActive`、`probeStatus`、自动调度器的费用闸、持久缓存、page/batch.js 都由这几个谓词拼出来 | B1：`isBuiltinSelected` 先问站点；新增同步谓词 `fallbackAllowed()`，`canFallBackToAI` 改为先问它；`fallbackAllowed` 挂到 `ctx.builtinTranslator` 上导出（§3.7） |
| `content/content-translation-engine.js:524-591`、`:601-618` | `handleWithBuiltin` 只处理 TRANSLATE / TRANSLATE_BATCH / TRANSLATE_BATCH_FAST；`pinnedEngine(message)` 只看 `message.engine`；`wantsBuiltin` 的注释说站点覆盖「将来加在这里」 | B1：`pinnedEngine` 不动；`wantsBuiltin` 在它之后加 `BUILTIN_TYPES` 判断，名单只有一份；注释改成指向谓词 |
| `content/content-translation-engine.js:443-468`、`:630-676` | 预算闸注释（`:457-459`）说「能走到这一行的自动请求只有两种」；`ctx.requestTranslation`，`:663-665` 在钉住而内置处理不了时抛错 | B1：注释改成三种；`requestTranslation` 开头 `await ctx.customRules.whenReady()`；抛错那一行不动 |
| `popup/popup.js:421`、`:466` | `refreshEngineStatus` 在 `translationEngine === 'ai'` 时不探测标签页；`translateCurrentPage` 的「没配 Key」拦截读 `settings.translationEngine` | B1：总是探测；拦截改读 `EngineStatus.selectedEngine(settings, probe)`（§3.7） |
| `shared/engine-status.js:98` | `describeEngineStatus` 取 `probe.engine`，没有就退回 `settings.translationEngine` | B1：这一步抽成 `EngineStatus.selectedEngine(settings, probe)`，与 popup 的拦截共用 |
| `content/captions/translate.js:219-225` | `translationWindowMs()` 用 `isActive()` 加直读 `engineFallback` 判断「免费」 | B1：改成 `builtin.isActive(false) && !builtin.fallbackAllowed()` |
| `content/content-auto-translate.js:486-526`、`:768-803`、导出 `restart: start`（B2 终态 :845） | 费用闸拒绝后停在 OFF 并停掉发现层；只有 RESTART_KEYS 设置键、换路由、语言包就绪会 `start()`；`restart: start` 是这里的导出 | B1：订阅 `ctx.customRules.onChange`，调 `restart('custom-rule')`（§3.6 第 5 步）；新导出 `isOn()`（状态为 IDLE 或 RUNNING） |
| `content/frames/top.js:45/:54/:62`、`:38-43`、`:74-80` | `computeDirective` / `sameDirective` / `broadcastDirective`，指令形状为 `{translate, manualEpoch, visible, scopeOverride}`；`currentTranslate()` 自己判断调度器开没开；`refreshDirective()` | B1：加 `engineOverride`；`currentTranslate()` 改用 `ctx.autoTranslate.isOn()`；`ctx.customRules.onChange` 触发 `refreshDirective()`（§3.6 第 4 步） |
| `content/frames/child.js:164-187` | `applyDirective`（`scopeOverride` 那段在 `:169-174`） | B1：`ctx.customRules.inherit(engineOverride)`，null 也照传 |
| `content/content-bootstrap.js:117-131`、`:192-204` | `setupStorageListener` 在 `:129-131` 把 sync 区变了的每个键都写进 `ctx.settings`；`ctx.init` | B1：新设登记表 `ctx.syncMirrors`，元素为 `{prefix, onStorageChange}`。bootstrap 在加载时（`content-bootstrap.js:119`）就建好这张空表，早于 `:226` 调 `ctx.customRules.init()`，所以登记方在 `init()` 里直接 `ctx.syncMirrors.push(…)`；监听器在事件到达时才读这张表。键命中某个前缀，就交给那一项的 `onStorageChange`，不进 `ctx.settings`。custom-rule.js 登记 `CustomRules.KEY_PREFIX`。P1-C 的词表以后登记自己的前缀：每个 frame 都登记，但只有顶层建镜像；子 frame 那一项什么都不做，只为让 `glossary:` 键不进 `ctx.settings`。bootstrap 一行不用改（D-306）。`ctx.init` 在启动调度器之前等 `whenReady()` |
| `content/content-messaging.js:27/:164` | `switch (message.type)`；`SETTINGS_UPDATED` | B2：加 `OPEN_RULE_PICKER`，只由顶层 frame 应答 |
| `options/options-auto.js:45-76` | `unattendedAiReachable()` `:45-49`；`syncAutoEngineState()` `:51-54`；`:56-67` 的注释自称是唯一的 `window.confirm`；`onAutoEngineChange` `:68-76` | B2：抽出 `confirmUnattendedAiSpend`，改注释；`syncAutoEngineState` 在 `unattendedAiReachable(...)` 之外并上 `customRulesUseAi()`。`unattendedAiReachable` 不动，P0-F 之后它只吃一个设置对象（§12.4） |
| `test/unit/auto-cost-gate.test.mjs:109-120` | `:118` 断言 `window.confirm(t('autoTranslateEngineAiConfirm'))`，`:120` 断言回退 | B2：改为断言两个调用点，且 `optionsSource()` 里恰好一个 `window.confirm(` |
| `options/options.html:188`、`:271-321`、`:880-941` | 自动翻译卡（引擎选择 `:213-216`）；「你表过态的网站」卡（`siteRules`）；脚本表 | B1：脚本表加 storage-writer、sync-collection、custom-rules；B2：新卡片放在 siteRules 卡之后 |
| `popup/popup.html:125/:156/:162`、`popup/popup.js:154-164` | 设置按钮；lang-tags、site-rules 脚本；`sendToActiveTab` | B1：site-rules 之前加 storage-writer；B2：加拾取器按钮 |
| `content/css/popup.css:100-103/:115/:122-124` | 重置层的 `:is()` 列表 | B2：加 `#ai-translator-rule-picker` |
| `manifest.json` `content_scripts[1]` `:95/:103/:104`、css 表 | lang-tags `:95`、site-rules `:103`、auto-stats `:104`；CSS 12 个 | B1：storage-writer 放在 site-rules 之前，sync-collection、custom-rules 依次放在 auto-stats 之后，`content/page/custom-rule.js` 放在 `site-adapter.js` 之前；B2：`content/picker/*`、`content/css/rule-picker.css`（放在 css 表末尾） |
| `content/page/insert.js:295`、`:562`（P0-C 所有） | `releaseTranslation(element)` 返回布尔值：去掉 `.ai-translator-translated`，恢复被藏起的原文；导出为 `ctx.releaseTranslation` | 只调用，不改 |
| `docs/privacy-policy.md:131-139` | 「三、存在你电脑上的东西」表，`:136` 是站点规则一行 | B2：在 `:136` 之后加一行 |

## 2. 数据与存储

### 2.1 sync 额度表（合计 = 100 KiB，即 `QUOTA_BYTES`）

| 占用方 | 额度 | 项数 | 依据 |
|---|---|---|---|
| 设置（`background/settings.js` 的 `defaultSettings` ∪ `shared/default-settings.js` 的 `CONTENT_DEFAULTS`） | ≤ 12 KiB | ≤ 80 | 实测：合并去重后 43 个键，默认值合计 1004 B（约 1.0 KiB），最大的是 `apiEndpoint`（55 B）；余下的空间留给用户改长的值和以后新增的设置 |
| `siteRules` | ≤ 6 KiB | 1 | 单键，受 `ITEM_BUDGET` 约束 |
| `siteAskCount` | ≤ 6 KiB | 1 | 同上 |
| `customRule:*` | ≤ 24 KiB | ≤ 50 | 本轮 |
| P1-C 词表 `glossary:*` | ≤ 32 KiB | ≤ 300 | P1-C 设计 §2.1 |
| P1-D 配置档 | ≤ 8 KiB | ≤ 20 | 预留 |
| 余量 | 12 KiB | ≥ 60 | |

另外几条 sync 硬限制：单项 8 KiB（`QUOTA_BYTES_PER_ITEM`，JSON 加键名）、最多 512 项（`MAX_ITEMS`，项数列之和 ≤ 452，留 60）、每分钟 120 次写、每小时 1800 次写；一次多键 `set` 算一次写。

### 2.2 规则结构 v1

```js
{
  id: 'k3f9x0qa',                  // 8 位 base36，CustomRules.newId()（crypto.getRandomValues）；只存在键里，见下
  v: 1,
  match: ['example.com', 'docs.example.com/guide/*'], // 1–8 条，每条过 SiteRules.validPattern，存规范化后的形式
  include: ['article.post'],       // 可选，≤ 50 条，每条 ≤ 500 字符
  exclude: ['.comments'],          // 同上
  keepOriginal: ['.brand'],        // 同上
  css: '.ai-translator-inline-block { color: #555 }', // 可选，≤ 4096 字符，已过清洗
  engine: 'ai',                    // 可选：'builtin' | 'ai'；缺省即跟随全局
  updatedAt: 1790000000000         // 由 SW 写入时填
}
```

- `id` 只存在键 `customRule:<id>` 里，存进去的值不带它（D-306）。`collect` 从键上取回来挂到条目上，值里即使带了 `id` 也不认；`write` 存之前去掉；`usage` 按存进去的形状算。每条省 16 B，也省掉「键和值里的 id 对不上时听谁的」这个问题。P1-C 的词表同样如此。
- 未知字段写入时丢弃。
- `v` 大于 1 的条目读取时当作不认识，直接跳过，免得旧版本误读新版本写的规则。
- `v` 取能表达这条规则的最低版本。以后给规则加字段时，只有用到新字段的规则写成新版本号；旧版本跳过这些规则，也就不会在读改写时把新字段丢掉。没用到新字段的规则仍写 v1，旧版本照常读写。
- 一个有效字段都没有的规则拒写（`customRuleInvalid`）。
- 选择器语法只能在有 DOM 的地方检查：`validateRule(rule, {checkSelector})` 的 `checkSelector` 由设置页和拾取器传入。SW 只查形状和长度。内容脚本在使用时还会再过一遍 `usableSelector`，无效的直接丢掉，不抛错。

### 2.3 `shared/custom-rules.js`（`globalThis.CustomRules`，双模经典脚本）

下表中的 `newId`、`collect`、`forHost`、`applyChanges`、`usage`、`assertFits` 由 `SyncCollection.create({prefix: 'customRule:', …})` 给出（§2.6），custom-rules 原样转出，自己不另写。`mergeImport` 先检查文件格式，再调集合的 `merge(existing, incoming, keyOf)`，`keyOf` 取 id。

| 导出 | 作用 |
|---|---|
| `KEY_PREFIX`、`LIMITS` | `'customRule:'`；`{ruleBytes: 6144, totalBytes: 24576, maxRules: 50, maxPatterns: 8, maxSelectors: 50, maxSelectorLength: 500, maxCss: 4096}` |
| `newId()` | 8 位 base36 |
| `validateRule(rule, {checkSelector})` | 返回规范化后的规则，或抛 `Error(<i18n 键>)` |
| `sanitizeCss(css)` | 原样返回（只拒不改），或抛 `Error('customRuleCssUnsafe')`（§0.1-10） |
| `collect(items)` | 把 `get(null)` 的结果变成规则数组：前缀过滤、校验，坏条目跳过 |
| `forHost(rules, host)` / `pick(rules, host, path)` | 按主机过滤 / 求胜出规则（§0.1-5），没有则为 null |
| `applyChanges(rules, changes, host)` | 纯函数，把 `storage.onChanged` 的增量应用到规则集上（增、替、删，别的主机的规则忽略） |
| `usage(rules)` | `{bytes, count}`，供用量表和额度检查共用 |
| `assertFits(rules)` | 额度检查（单条、合计、条数），超了抛对应的错误键；写入和导入预览共用 |
| `mergeImport(existing, file)` | 返回 `{rules, added, replaced, aiCount}`，`aiCount` 是文件里 `engine: 'ai'` 的条数；格式不对或任一条无效，都整体抛 `customRulesImportInvalid`（单条的具体原因放在 `cause` 里） |
| `toExportFile(rules)` | 生成 §0.1-16 的对象 |
| `applyWrite` / `request` | 由 `StorageWriter.create({type: 'CUSTOM_RULES_WRITE', writes, errors: 'throw'})` 给出 |

加载位置：SW、内容脚本、设置页；popup 不加载。它在加载时捕获 `SiteRules`、`StorageWriter` 与 `SyncCollection`，缺了就抛错（沿用 LangTags 的先例）。

### 2.4 写入：SW 单写者，`CUSTOM_RULES_WRITE`

消息的判别字段叫 `kind`，和 StorageWriter 的 `request(kind, payload)`、site-rules 的 `WRITES` 表用同一个名字（D-306）。

| kind | 参数 | 结果 |
|---|---|---|
| `put` | `{rule}` | 新增，或整条替换同 id 的规则；返回 `{id}` |
| `remove` | `{id}` | 删掉一条 |
| `import` | `{file}` | `file` 是解析好的对象（§0.1-16），不是 JSON 文本；设置整份导入（§12.4）原样传同一个对象。`mergeImport` 后一次多键 `set`；返回 `{added, replaced}` |
| `addSelector` | `{host, path, field, selector}` | 把选择器追加到这个 URL 的胜出规则的 `field` 里，已有则不重复；没有胜出规则就新建一条，`match: [normalizeHost(host)]`；返回 `{id}` |

每个 kind 的步骤都一样：`get(null)` → 前缀过滤 → 算出结果 → `assertFits` 检查额度（单条 6 KiB、合计 24 KiB、50 条）→ 写入。这套步骤就是 `SyncCollection` 的 `write(compute)`（§2.6），每个 kind 只写自己的 `compute`。

错误以 i18n 键作为 `error` 返回：`customRuleInvalid`、`customRuleCssUnsafe`、`customRuleMatchInvalid`、`customRuleSelectorInvalid`、`customRuleTooLarge`、`customRulesBudgetFull`，其余一律 `customRuleSaveFailed`。

StorageWriter 的 'throw' 模式在没有 runtime 时返回一个被拒的 Promise。今天 site-rules 在这种情况下是同步抛 TypeError，所以实现时要逐个核对 `SiteRules` 写入的调用方，交付时列出来。

### 2.5 读取

下面三种读法都由 `SyncCollection` 实现（§2.6），custom-rules 只提供参数。

- **SW** 处理 `CUSTOM_RULES_FOR_HOST`（`background/custom-rules-host.js`）：用 `new URL(sender.url).hostname` 取主机 → `get(null)` → `collect` → `forHost` → 回 `{rules}`。这里回的是该主机的全部规则，路径交给内容脚本去挑。SW 在模块内存里记住 `collect` 的结果，收到 `customRule:` 键的 `storage.onChanged` 就作废。SW 随时可能被回收，这份记忆只是缓存。
- **内容脚本**：每个文档只发一次请求。请求在路上时收到的增量先按顺序缓冲，回话到了再依次应用。此后的增量经 `applyChanges` 处理，去抖约 150 ms，然后 `version++` 并通知订阅者。
- **设置页**：`get(null)` → `collect`，并挂自己的 `onChanged` 监听。

### 2.6 `shared/sync-collection.js`（`globalThis.SyncCollection`，双模经典脚本；D-302 修订，§0.1-20）

`SyncCollection.create(spec)` 的参数：

| 字段 | 含义 | custom-rules 的取值 |
|---|---|---|
| `prefix` | 键前缀 | `'customRule:'` |
| `decode(value)` | 把存储里的一项变成条目；坏条目、不认识的 `v` 返回 null | `validateRule` 只查形状的那一半 |
| `hosts(entry)` | 条目作用的主机表，空数组表示所有主机 | `match` 里每条模式的主机部分 |
| `limits` | `{itemBytes, totalBytes, maxItems}` | `{6144, 24576, 50}` |
| `errors` | `{tooLarge, budgetFull}`，两个 i18n 键 | `customRuleTooLarge`、`customRulesBudgetFull` |

返回的对象：

| 成员 | 用在哪 | 作用 |
|---|---|---|
| `prefix`、`newId()` | 各处 | `newId()` 生成 8 位 base36（`crypto.getRandomValues`） |
| `collect(items)` | 各处 | 把 `get(null)` 的结果变成条目数组：前缀过滤、`decode`，坏条目跳过。条目的 `id` 一律取自键（`key.slice(prefix.length)`），值里带的不认（§2.2）。一次 collect 最多记一条日志，写明跳过了几条 |
| `forHost(entries, host)` | 各处 | 留下 `hosts(entry)` 为空、或其中任一个满足 `SiteRules.hostMatches(host, h)` 的条目 |
| `applyChanges(entries, changes, host)` | 内容脚本、设置页 | 纯函数，把 `storage.onChanged` 的增量应用成新数组：增、替、删；别的主机的条目忽略，`host` 为 null 时不按主机过滤 |
| `usage(entries)` | 设置页、SW | 返回 `{bytes, count}`，按存进去的形状算：键名加上不带 `id` 的值（sync 配额的口径就是 JSON 加键名，`StorageWriter.itemBytes` 只量值） |
| `assertFits(entries)` | SW、设置页 | 按 `limits` 查单条、合计、条数，超了抛 `errors` 里对应的键。`write` 和导入预览都调它，额度规则只有一份 |
| `merge(existing, incoming, keyOf)` | 导入 | 按 `keyOf` 合并。键相同就替换，并沿用原来的 id；否则新增，没有 id 的发一个新 id。返回 `{entries, added, replaced}` |
| `write(compute)` | SW 的写队列 | `get(null)` → `collect` → `compute(entries)`，它返回 `{put, remove, result}` → `assertFits(写后的集合)` → 一次多键 `set`（键为 `prefix + id`，值去掉 `id`）加一次 `remove` → 返回 `result` |
| `cached()` | SW | 记住 `collect(get(null))` 的结果。`create` 在 SW 里挂一个 `storage.onChanged`，键前缀命中就作废 |
| `mirror({request, host})` | 内容脚本 | 返回 `{whenReady(), onStorageChange(changes), entries(), version, subscribe(fn)}`，即 §2.5 内容脚本那一条：每个文档只 `request()` 一次，缓冲在途增量，去抖 150 ms，递增版本号并通知订阅者。增量经 `applyChanges(entries, changes, host)` 应用，`host` 由调用方传入，模块里不读 `location`：这个文件在 SW、设置页和内容脚本里都加载，隐式取主机只在其中一处对。镜像的主机必须和 SW 回话时用的主机相同：规则传本 frame 的 `location.hostname`，与 SW 用 `sender.url` 取的一致；词表只在顶层建镜像，传顶层主机。首个回话到达、或超过 1500 ms，`whenReady()` 就 resolve：超时按空集合处理，回话晚到仍照常生效。这个上限只写在这里，规则和 P1-C 的词表共用（D-306） |

- 「是否在 SW 里」沿用 `StorageWriter` 的同一个谓词，不另写一份。
- 加载位置与 custom-rules 相同，排在 storage-writer、site-rules 之后。
- 单测 `test/unit/sync-collection.test.mjs` 逐个覆盖上表的成员。
- 另写一条防抄写扫描：`storage.onChanged`、`get(null)` 和去抖计时器只准出现在 sync-collection.js 里，不准出现在建在它上面的模块（custom-rules，以及 P1-C 的 glossary）里。

## 3. 页面接线（B1）

### 3.1 `ctx.customRules`（`content/page/custom-rule.js`）

| 成员 | 作用 |
|---|---|
| `init()` | 建镜像 `SyncCollection.mirror({request, host: location.hostname})`，由它发出 `CUSTOM_RULES_FOR_HOST`；主机取本 frame 的，与 SW 用 `sender.url` 取的一致（§2.5、§2.6）。dormant frame 根本不建 ctx，自然什么也不发 |
| `whenReady()` | 就是镜像的 `whenReady()`（§2.6）：首个回话到达，或超过 1500 ms，Promise 就 resolve。超时按「无规则、全局引擎」处理，回话晚到仍照常生效 |
| `current()` | 本 URL 的胜出规则，形状 `{id, include, exclude, keepOriginal, css, engine}`，或 null。以 `location.href` + `version` 记忆，SPA 换路径后自然重算 |
| `version` | 规则集每变一次加 1。它只是记忆键：别的站点的规则变了也会加，不表示本页规则变了 |
| `onStorageChange(changes)` | 经 `ctx.syncMirrors` 登记（§1），接收 bootstrap 转来的 `customRule:` 增量 |
| `engineOverride()` | 顶层返回 `current().engine`；子 frame 返回从顶层指令继承来的值 |
| `inherit(engine)` | 子 frame 专用；null 也要照传，表示「顶层没有覆盖」 |
| `onChange(fn)` | **本页生效的规则**变了才回调（D-303）。<br>• 本页生效的规则 = `current()` 的 id、include、exclude、keepOriginal、css，加上 `engineOverride()`。规范化成 JSON，作为签名。<br>• 三个时机重算签名：规则集增量去抖之后；换路由之后（`SpaNavigation.onRouteChange`）；子 frame 的 `inherit` 收到新值之后。<br>• 签名和上次一样就不回调。所以改别的站点的规则，这一页什么都不做。<br>• 签名里取 `engineOverride()`，不取规则自己的 `engine` 字段，这样顶层和子 frame 用同一个定义 |
| `beginRound()` | 每轮收块开始时由 scope.js 的 `beginScopeRound()` 调，按当前 URL 重新挂一次 CSS（§3.5） |
| `isCatchingUp()` / `whenCaughtUp()` | 补翻轮（§3.6 第 3 步）是否在跑 / 它结束时 resolve 的 Promise（没在跑就立即 resolve）。调度器在 `isCatchingUp()` 为真时和手动整页翻译一样让路；手动整页翻译与子 frame 手动轮先等 `whenCaughtUp()` 再收块 |
| `rescope()` | 「范围在轮次中途变了」唯一的一条路（T1）：§3.6 第 2 步当场清扫（解析 `resolvePageScope()`、筛 `ctx.ruleForbids`、逐个 `ctx.releaseTranslation`）；有轮次在跑就记 `pending`；第 3 步补翻与第 4、5 步回调订阅者排进一个微任务，同一个同步段里多次调用只排一次、只回调一次。规则变化由 `recompute()` 调；include 晚到命中时由 scope.js 调（§3.4） |
| `afterRound()` | 一轮手动整页翻译、子 frame 手动轮或补翻轮结束时调（旗标已清）。这一轮进行中规则变过，就补做第 2、3 步（§3.6）；没变过什么都不做 |

有三处要等 `whenReady()`：`ctx.init` 启动自动翻译调度器之前；整页翻译入口；`ctx.requestTranslation` 开头。SW 冷启动时，这最多让首轮推迟 1.5 s。

### 3.2 与内置适配器合并

`resolveSiteAdapter()` 返回 `{atomic, exclude, keepOriginal}` 或 null（三串都空时），缓存键加上 `version`：

- atomic：只来自内置 `atomicBlockSelectors`；
- exclude：只来自用户规则；
- keepOriginal：内置 `keepOriginalSelectors` ∪ 用户 keepOriginal（D-315）。

三串各自逐条过 `usableSelector`，owner 分别标 'builtin' / 'user'，坏选择器只丢那一条。site-adapter.js 同时把 `usableSelector` 导出为 `ctx.usableSelector`，scope.js 的 include 选择器走同一道校验。include 由 scope.js 读 `current()`；exclude 与 keepOriginal 由 collect.js 从适配器读。「用户优先」只体现在一处：keepOriginal 可以加，但撤不掉内置的。

### 3.3 exclude / keepOriginal

| | 命中一个块 | 命中块里的行内元素 |
|---|---|---|
| exclude（用户） | 整块跳过（`closestAcross`，collect.js:293） | 它的文字从原文里拿掉：不送去翻译，译文里也不出现 |
| keepOriginal（内置 ∪ 用户） | 整块跳过（`ctx.ruleForbids`，在 translate judge 之前判） | 按 `translate="no"` 处理：送出占位符，译文里原样出现（collect.js:710-714） |

块级判法只有一份：collect.js 的 `ruleBlocksElement(el, adapter)`，答「exclude 或 keepOriginal 命中这个元素或它的祖先（`closestAcross`，跨 shadow）」。收块的 `processElement` 和清扫的 `ctx.ruleForbids` 都调它。`ctx.ruleForbids(el, scope)` 定义在 collect.js：`ruleBlocksElement(el, resolveSiteAdapter())` 为真，或 `ctx.outsidePageScope(el, scope)` 为真。

### 3.4 范围阶梯（改 `content/page/scope.js` 的 `pageScopeMode` / `resolvePageScope`）

1. `state.pageScopeOverride === 'page'`（来自「翻译整个页面」入口）→ 'page'
2. `current().include` 在 `queryAllDeep` 下至少命中一个已渲染元素（`getClientRects().length > 0`）→ 'include'
3. 设置 `pageTranslateScope === 'page'`，或 `matchBuiltin` 命中 → 'page'
4. 否则 → 'main'

- **include 的结果形状**是 `{mode: 'include', roots, skip: null, share: null}`。`roots` 取命中元素里最外层的那些：被别的命中元素包含的去掉。第 2 档零命中时不缓存，下次调用再判。
- **`pageScopeStarts(dirty, scope)` 的 include 分支**：`dirty` 在某个 root 里 → `[dirty]`；`dirty` 包含若干 root → 返回这些 root；两者不相交 → `[]`。不做 'main' 模式那套孤儿 h1 处理。
- **`ctx.outsidePageScope(el, scope)`** 定义在 scope.js，只在 include 模式下可能为真：`el` 不在任何 root 里时为真。
- **`pageScopeMode()` 多了一个取值 'include'**。所有写 `=== 'main'` / `=== 'page'` 的调用点要逐个核对，交付时列出来。悬浮球的 `showWholePage` 改成 `!== 'page'`，所以 include 模式下也提供「翻译整个页面」。
- **缓存**：`resolvePageScope()` 的缓存键加上 `ctx.customRules.version`，这是规则变化唯一需要的作废手段。范围从别的模式切到 include 时，同样走 §3.6 第 2 步的清扫；无论是规则变更引起的，还是 include 晚到命中引起的。
- **晚到命中的清扫时机**：规则变更引起的，在 §3.6 的流水线里做。include 晚到命中引起的（规则没变，区域后渲染出来），发生在晚到之后第一次解析范围时：上一次解析零命中、退回了下一档，这一次命中，`resolvePageScope()` 先把 include 范围写进缓存、清掉「上一次是退下去的」标记，再调 `ctx.customRules.rescope()`（§3.1）。自动模式下这一次是发现层的下一轮（区域插入本身就触发一轮）；手动模式下是下一次整页翻译或补翻。
- **晚到命中与规则变化走同一条路（T1）**：清扫那一刻，退下去的范围里收的块可能还没挂上——手动轮后面的批次、自动路径在路上或在排队的块。只扫一次收不回它们。所以晚到命中和规则变化一样：当场清扫；有手动轮或补翻轮在跑就记 `pending`，那一轮收尾时 `afterRound()` 再扫；自动路径的调度器重启（会话号 +1，队列清空，在路上的结果由会话守卫挡掉）。重启推迟到解析范围的同步段之后的微任务里：`resolvePageScope()` 是在收块途中被同步调到的，在那里重启会在发现层自己的回调里拆掉它；用微任务而不是下一轮事件循环，是要赶在调度器的启动防抖定时器之前把排队的块作废。收块处（`acceptBlock`、`takeBatch`、手动轮挂译文）不另加范围判定。

### 3.5 CSS

- `custom-rule.js` 只持有一个 `CSSStyleSheet`，用 `replaceSync(清洗后的文本)` 填充，挂载写法为 `document.adoptedStyleSheets = [...当前列表去掉我们那张, 我们那张]`，页面自己的 sheet 保留。
- 两个时机重新挂载：每轮翻译开始时（按当前 URL 重算 `current()`）；每次规则变化时。这是因为有些页面会整体重写 `adoptedStyleSheets`，把我们那张冲掉。
- 构造或挂载抛错时，在接住的地方打一条日志（操作名 + 原始错误），本页不应用这段自定义 CSS；规则的其余字段照常生效。没有 `<style>` 退路（D-297）。
- 内容侧清洗不过，就不应用这段 CSS，只打一条 `console.warn`；规则的其余字段照常生效。
- 不注入 shadow root。

### 3.6 规则变化后的流水线（≤ 1 s）

规则集收到增量、去抖之后，先 `version++`。这一步和本页规则变没变无关：site-adapter 和 `resolvePageScope()` 的缓存键里有 `version`，也有 URL（§3.2、§3.4），所以规则集增量和换路由都会让它们自然换键，不需要另外作废。

然后按 §3.1 重算本页签名。签名没变就到此为止；变了就按顺序做下面五步，每一步由谁做见本节末的「执行顺序」：

1. CSS 重新挂载（§3.5）。
2. **清扫**：`queryAllDeep('.ai-translator-translated')`，筛出 `ctx.ruleForbids(el, scope)` 为真的元素，逐个 `ctx.releaseTranslation(el)`（P0-C 的导出，只调用）。
3. **补一轮增量收块**，把新放开的块（比如删掉了一条 exclude）翻上。
   - 只在四个条件都成立时做：页面整页翻过（`state.pageHasBeenTranslated`）；调度器没在跟这一页；没有手动整页翻译在跑；没有补翻轮在跑。
   - 调度器在跟时，由第 5 步的重启接手，免得两条路收同一批块。
   - 后两个条件不成立（手动整页翻译、子 frame 手动轮或补翻轮进行中）时，第 1、2 步照常当场做，并记下这次变化；由那一轮结束时的 `afterRound()` 再做第 2、3 步。这几种轮次挂译文时没有 accept 守卫，变化前送出去的块，译文回来照样挂进新禁止的区域，所以收尾时要再清扫一次。
   - 补翻轮用自己的旗标，不改 `state.isTranslatingPage`，也不改顶层指令：那个旗标是手动整页翻译的，顶层指令和「翻译整页」的忙分支都读它，补翻不是用户表态。手动整页翻译与子 frame 手动轮等补翻轮结束（`whenCaughtUp()`）再收块，调度器在 `isCatchingUp()` 为真时让路，两轮不同时收。
   - 「在跟」= 调度器状态是 IDLE 或 RUNNING。今天这个判断写在 `frames/top.js` 的 `currentTranslate()` 里（:38-43）。B1 把它提成调度器的导出 `ctx.autoTranslate.isOn()`，两处共用。
4. 顶层 frame 调 `refreshDirective()`。`computeDirective()` 带上了 `engineOverride`（§3.8），变了就广播。
5. **重启自动调度器**：`ctx.autoTranslate.restart('custom-rule')`（content-auto-translate.js 的导出 `restart: start`，B2 终态在 :845）。
   - 和 RESTART_KEYS 里的设置键变化走同一条路。
   - 没有这一步，有两种页面会卡住，要刷新才能恢复：
     - 费用闸拒绝后停在 OFF 的页面（content-auto-translate.js :514-526）：规则把引擎改成内置，它也醒不过来；
     - 删掉一条 exclude 后：被排除过的块早在进带时就被摘掉了，不会自己回来。
   - 换路由时，调度器自己也会 `start` 一次（:747-766）。这里再 restart 一次无害：同一拍里的第二次 `start` 只会作废第一次刚起的那一轮。

执行顺序：第 1～3 步是 `content/page/custom-rule.js` 自己的，在回调任何外部订阅者之前做完；然后按订阅顺序回调外部订阅者。第 1、2 步和「记 `pending`」当场做；第 3 步与回调订阅者由 `rescope()`（§3.1）排进同一个微任务，先补翻判定、后回调，订阅者取排进去那一刻的快照（加载时首个回话触发的那一次，调度器还没订阅，不补给它）。调度器（`content/content-auto-translate.js:819`）比顶层（`content/frames/top.js:167`）先订阅，所以第 5 步先于第 4 步。两种顺序结果一样：顶层还订阅了调度器的状态变化（`top.js:165` `onStateChange(refreshDirective)`），调度器重启引起的状态变化同样会让它重算指令，最后广播的指令已带上新的 `engineOverride`。第 3 步必须赶在第 5 步之前读 `isOn()`：重启之后调度器一定在跟，这时再读，停在 OFF 的页面（比如额度用完）就会跳过手动的增量收块。

子 frame 的流水线相同，只是没有第 4 步（指令由顶层发）。顶层第 4 步广播之后，子 frame 的 `inherit` 收到新引擎，签名随之变化，子 frame 再走自己的一遍。

**已有译文不重译**：
- 引擎变化只影响之后的请求。
- 重启调度器也不重译：`start()` 清掉的是台账和在途请求；重扫时，`alreadyTranslated` 能认出已挂着当前语言译文的块。

### 3.7 引擎（D-303）

**钉住落在谓词层，不进 `pinnedEngine`。** 引擎文件里问「内置还是 AI」的有这些：`effectiveEngine`（:437）、`isActive` 即 `shouldUseBuiltin`（:93）、`probeStatus`（:720），以及它们的调用方：自动调度器的费用闸（content-auto-translate.js:487）、持久缓存（content-translation-cache.js:75）、page/batch.js:148。它们全由 `isBuiltinSelected` / `canFallBackToAI` 拼出来，没有一个读 `pinnedEngine`。钉在 `pinnedEngine` 里，请求走一条路、谓词答另一条：popup 说走 AI，请求实际走了内置；费用闸以为走内置不花钱，请求实际花了 AI。

```js
// 设置页也加载引擎这一族，那里没有站点
const siteEngine = () => (ctx.customRules ? ctx.customRules.engineOverride() : null);

function isBuiltinSelected(auto) {
  const site = siteEngine();
  if (site) return site === 'builtin';
  return (auto ? settings.autoTranslateEngine : settings.translationEngine) !== 'ai';
}

// 同步判断：这次请求能不能回退到 AI。站点钉住的永不回退
function fallbackAllowed() {
  return !siteEngine() && settings.engineFallback === 'allow-ai';
}

async function canFallBackToAI() {
  if (!fallbackAllowed()) return false;
  if (!aiConfig) await refreshAiConfig();
  return aiConfigured();
}
```

- **优先级**：`message.engine` > 站点 > 设置。`pinnedEngine`（:601-607）和「钉内置而内置处理不了就抛错」那一行（:663-665）都不动，仍只看 `message.engine`，P0-D 的代码不用改。
- **设置和站点只管内置能处理的三种类型**：TRANSLATE、TRANSLATE_BATCH、TRANSLATE_BATCH_FAST。
  - `wantsBuiltin`（:614-618）先看 `pinnedEngine`；没指名时，类型不在 `BUILTIN_TYPES` 里就直接走 AI。这样 http 和 https 上行为一致。没有这一道时，选了内置（全局或站点）的这类请求在 https 上由 `handleWithBuiltin` 的 `default: return null` 落到 AI，在 http 上却先撞 UNSUPPORTED_ENV；站点钉住又不许回退，http 上就只剩报错。
  - 名单只有一份：`handleWithBuiltin`（:524-591）的分支读这个集合，或者单测断言它的 case 标签与集合相等。
  - `wantsBuiltin` 注释里「将来加在这里」（:611）改成指向谓词。
  - 今天没有调用方发别的类型，这一道是为以后设的。
- **http 上钉内置**：`effectiveEngine` 答 `'none'`，自动翻译不跑；手动请求拿到 UNSUPPORTED_ENV 那条错；`mayFallBack`（:637）为假，不回退。
- **费用闸**：`refuseAutoAiSpend()` 的代码不动。注释（:457-459）从「两种」改成「三种」，第三种是：站点钉 AI 的自动 / 无人值守请求。钉 AI 而没配 Key，走现有的「没配 Key」路径（P0-A 所有，不碰）。
- **导出**：`fallbackAllowed` 挂到 `ctx.builtinTranslator`（:753）上。

**谓词外的三处直读收口。** 这三处绕过谓词直接读设置，会无视站点钉住：

| 位置 | 今天 | 改成 |
|---|---|---|
| `popup/popup.js:421` | `translationEngine === 'ai'` 时不探测标签页 | 总是探测，由标签页按站点作答；删掉注释「自定义接口那条路与页面无关」 |
| `popup/popup.js:466`、`shared/engine-status.js:98` | 「没配 Key」拦截读 `settings.translationEngine`；`describeEngineStatus` 取 `probe.engine`，没有就退回设置 | 两处共用新函数 `EngineStatus.selectedEngine(settings, probe)`：`probe.engine` 优先；探测超时或页面没有内容脚本时，退回设置 |
| `content/captions/translate.js:219-225` | `translationWindowMs()` 用裸调用 `builtin.isActive()` 加直读 `engineFallback` 判断「免费」 | `builtin.isActive(false) && !builtin.fallbackAllowed()` |

设置页 `options/options-auto.js` 的每日额度格由 §0.1 第 19 条覆盖（`syncAutoEngineState()` 并上 `customRulesUseAi()`，`unattendedAiReachable` 不动），这里不重复。

**裸调用扫描的盲区，同类一并修。** `test/unit/auto-engine-choice.test.mjs`（:171-182）不许 `isActive()` / `isSelected()` 不带参数调用，但它的正则只认 `builtinTranslator.isActive()` 这一种写法。先把 `ctx.builtinTranslator` 存进局部变量再调的，它看不见。今天漏过去三处：

| 位置 | 今天 | 改成 |
|---|---|---|
| `content/captions/translate.js:221` | `builtin.isActive()`，问的是手动那一半 | 上表那一行已经改成 `isActive(false)`：字幕跟手动引擎走 |
| `content/content-language-pack.js:101`、`:161` | `engine.isActive()`。预取只在手动那一半选内置时才挂；「语言包装好」的广播也只叫醒手动那一半选内置的页面 | 文件里加一个局部函数 `inUse()`，写成 `engine.isActive(false) \|\| engine.isActive(true)`，两处都调它 |

语言包这两处问的是「这一页有没有哪一半在用内置」。文件自己的注释（:120-128）写着，要叫醒的正是停在 ERROR 上的**自动**那一轮。可是它问的是手动那一半。今天手动选 AI、自动保持默认的内置时，包从不预取；设置页下完包，自动那一轮也醒不过来，要刷新页面。站点钉住之后，两半在钉住的站点上答同一个值，这两处跟着站点走，不需要另写。

扫描的正则放宽成任意接收者：`\.(isActive|isSelected)\(\s*\)`。今天在 `content/` 下命中的恰好是上面三处，B1 改完后为零。`content-video-captions.js:122` 是方法定义，前面没有点，不会命中。

**单测扫描**，防第四处出现：
- 扫的是去掉注释后的属性读取 `.engineFallback` / `.translationEngine` / `.autoTranslateEngine`，以及 `getSetting('engineFallback' | 'translationEngine' | 'autoTranslateEngine')`。
- 白名单：引擎一族（`engineSource()`）、`shared/engine-status.js`、`options/`。
- 默认值对象（popup.js:30 的 `translationEngine: 'builtin'`、`shared/default-settings.js`、`background/settings.js`）和 RESTART_KEYS 里的字符串不是这个形状，扫不到，不用进白名单。
- 今天白名单外命中的恰好是上表三处，B1 改完后为零。

**排期**：P0-D 已合入（#111），B1 直接在 main 上做。

### 3.8 frames

- 顶层 `computeDirective()` 加上 `engineOverride: ctx.customRules.engineOverride() || null`，`sameDirective()` 把它也纳入比较。
- 顶层 `setupTopFrame` 在订阅 `ctx.autoTranslate.onStateChange(refreshDirective)`（:164）的旁边，再订阅 `ctx.customRules.onChange(refreshDirective)`，这就是 §3.6 第 4 步。换路由也会重算签名（§3.1），所以 SPA 换到另一条规则管的路径时，子 frame 同样收到新引擎。
- 顶层 `currentTranslate()`（:38-43）改用 `ctx.autoTranslate.isOn()`，与 §3.6 第 3 步共用一个判断。
- 子 frame 的 `applyDirective()` 调 `ctx.customRules.inherit(directive.engineOverride ?? null)`，null 照传。`scopeOverride` 同样照传 null，#107 已改好（`child.js:169-174`，§12.1）。
- 子 frame 的 include / exclude / keepOriginal / CSS 来自它自己 URL 的 `CUSTOM_RULES_FOR_HOST`。

## 4. 设置页（B2，`options/options-custom-rules.js`）

新卡片「站点翻译规则」放在「你表过态的网站」卡（`siteRulesTitle`）之后，两者标题不冲突。

- **列表**：每条规则一行，显示第一条匹配模式（多于一条时加「+N」），以及字段小标签。小标签就是编辑器里那个字段的标签（只翻译这些区域 / 不翻译这些区域 / 保留原文 / 自定义 CSS / 翻译引擎），两处读同一张表 `CUSTOM_RULE_FIELD_LABELS`，叫法分不开。按钮是「编辑」「删除」；删除分两步，先点「删除」再点「确认删除」。
- **编辑器**：在原位展开，列表顶上有「新建规则」按钮。
  - 字段：匹配网址、只翻译这些区域、不翻译这些区域、保留原文，都是每行一条；自定义 CSS 用等宽 textarea，提示里写明译文的类名 `.ai-translator-inline-block`、被禁止的写法，以及反斜杠会被拒；翻译引擎是下拉框，选项为「跟随全局设置」（`customRuleEngineFollow`）/ 复用 `autoTranslateEngineBuiltin` / 复用 `autoTranslateEngineAi`。
  - 按钮「保存」「取消」。错误显示在对应字段下方，选择器逐条用 `checkSelector` 检查。
- **引擎确认**：引擎从非 'ai' 改成 'ai' 时，调 `confirmUnattendedAiSpend('customRuleEngineAiConfirm')`。用户取消，下拉框回到原值，也不保存。
- **用量表**：「已用 x KiB / 24 KiB · n / 50 条」，数字来自 `CustomRules.usage`。
- **导出**：Blob 加 `<a download="blab-site-rules-YYYYMMDD.json">`。
- **导入**：
  1. 用户选文件，前端解析后给出预览：「将新增 N 条、替换 M 条」。预览只由一个函数算：`previewCustomRulesImport(file)`（options-custom-rules.js 的全局函数），对存储里现有的规则（现读）跑 `CustomRules.mergeImport`，不用卡片手里那份（整份导入可能在卡片读回来之前就点了），再用 `CustomRules.assertFits` 查合并后的额度，返回 `{added, replaced, aiCount}`，出错抛错误键。卡片和设置整份导入（§12.4）共用它（D-306）。
  2. 若 `aiCount` 大于 0，预览里多一行 AI 提示：「其中 K 条会让这些网站的自动翻译使用你的 AI 接口，并计入每日 AI 额度」，K 即 `aiCount`。
  3. 按钮「导入」「取消」。
  4. 格式不对或有无效条目报 `customRulesImportInvalid`，超额报 `customRulesBudgetFull`（单条超 6 KiB 报 `customRuleTooLarge`）；这几种情况存储都不变。
- **联动**：设置页挂自己的 `storage.onChanged` 监听（sync 区的 `customRule:` 键），变化后重绘。P0-B 的 `options/options-sync-mirror.js` 只镜像 `IMMEDIATE_SAVE_FIELDS`，两边的键不相交，设置页不需要登记表。全局函数 `customRulesUseAi()` 判断是否有规则 `engine === 'ai'`。每次重绘后调 `syncAutoEngineState()`，让每日额度输入框的启用状态跟上。
- **`options-auto.js` 的改动**：抽出 `confirmUnattendedAiSpend(messageKey)`，`onAutoEngineChange` 改为调用它；`:56-67` 的注释同步改；`syncAutoEngineState()` 在 `unattendedAiReachable(...)` 之外直接并上 `customRulesUseAi()`，不加 `typeof` 守卫：设置页脚本共用一个全局作用域，调用都发生在 DOMContentLoaded 之后，守卫只会把漏加载变成静默的「没有规则」。`unattendedAiReachable` 在 P0-F 之后只吃一个设置对象，B2 不动它，也不往里并规则项（§0.1-19、§12.4）。

## 5. 页内拾取器（B2，`content/picker/*`，shelf `ctx.picker`，根节点 `#ai-translator-rule-picker`）

### 5.1 文件与行为

| 文件 | 管什么 |
|---|---|
| `content/picker/selector.js` | 生成与校验选择器：优先级见 §0.1-14；`isVolatileClass` 识别哈希类名（如 `css-1x2y3z`、`sc-AbCdE`、`_3fX9a`，以及含 ≥ 3 位连续数字的）；唯一性只在元素自己的 root（document 或 shadow root）里判 |
| `content/picker/toolbar.js` | 悬停描框（`position: fixed`、`pointer-events: none`，贴合目标的 `getBoundingClientRect()`）；工具条 |
| `content/picker/picker.js` | 入口：`open()` / `close()`、事件捕获、保存 |

- **只在顶层 frame 工作**：`OPEN_RULE_PICKER` 由 A1 钉到 frame 0，子 frame 不应答。
- **主机名为空时两个入口都不出现**（`file://` 等页面）：判据是 `SiteRules.normalizeHost(location.hostname)` 为空，也就是 `siteRuleWritable()`（shared/site-rules.js:275）的前一半，这种页面生不出规则键。黑名单那一半**不用**：黑名单只拒自动翻译，手动整页翻译在那里照样能用，排除和保留原文规则仍然有意义。
- **打开后**：在 `window` 上以 capture 阶段监听 `pointermove`、`pointerdown`、`mousedown`、`mouseup`、`click`、`keydown`。凡是不落在我们根节点里的事件，一律 `preventDefault()` 加 `stopPropagation()`，页面上的链接和按钮都不会响应。目标取 `event.composedPath()[0]`，能穿进 open shadow root（D-294 #3）。
- **点选后**锁定目标，工具条显示五样东西：
  - 可编辑的选择器输入框，初值为生成的选择器；
  - 「匹配 {n} 处」，用 `queryAllDeep` 实时计数，含 shadow；
  - 「↑上一层」，取 `parentElement`，没有就取 `getRootNode().host`，这样能越过 shadow 宿主；
  - 三个动作「不翻译这里」（exclude）/「保留原文」（keepOriginal）/「只翻译这里」（include）；
  - 「取消」。

  选择器无效或命中 0 处时，三个动作按钮置灰。

  「不翻译这里」和「保留原文」两个按钮下面各有一行可见的说明（B2），把两者只在行内元素上才有的区别说出来：
  - `pickerExcludeTip`：「这段文字不进译文（仅译文模式下它在页面上就看不到了）。选中整块时，整块不翻。」
  - `pickerKeepOriginalTip`：「这段文字原样留在译文里。选中整块时，整块不翻。」

  设置页编辑器的「排除」「保留原文」两个字段用同两句作字段提示（`options/options-custom-rules.js:303`、`:306`），不另写文案。
- **保存**：发 `CUSTOM_RULES_WRITE`，`kind` 为 `addSelector`，参数 `{host: location.hostname, path: location.pathname, field, selector}`。成功后提示 `pickerSaved`（「已保存，可在 设置 → 站点翻译规则 里修改」），关闭拾取器；§3.6 的流水线会让页面在 1 s 内变化。失败时提示错误键对应的文案，拾取器保持打开。
  - 本站胜出规则的 CSS 不安全时（`writeAddSelector` 对整条规则跑 `validateRule`，追加选择器也被拒），错误键 `customRuleCssUnsafe` 在拾取器里换成 `pickerCssUnsafe`（「本站规则里的 CSS 含被禁止的写法，这里没法往规则里加内容。请先到 设置 → 站点翻译规则 里改掉那段 CSS。」，`content/picker/picker.js:117`）：拾取器里改不了 CSS，所以这句指向设置页。存储不变，拾取器保持打开。
- **Esc 或「取消」**：移除全部节点和监听器，不留痕迹（e2e 断言残留为零）。
- **几何**：视口 1280×800 与 375×812 下，工具条都完整落在视口内，描框与目标 rect 的误差 ≤ 1 px。
- **询问条让位**：拾取器开着时，自动翻译的询问条（连同状态说明、offer）收起，关掉后按原状态画回来（`ctx.yieldAutoStatus`，`content/content-auto-status.js`）。保存提示（notice）照常显示。几何用例在询问条已出现的前提下断言：低处的目标上面没有任何我方节点，能锁定；关掉后询问条回来。
- **入口**：
  - 悬浮球菜单项 `edit-site-rule`，文案 `pickSiteRegion`（「调整本站翻译区域」/ "Adjust what gets translated here"）。菜单已经自己量高度（`content/content-float-ball.js:566-569`），加一项不用算高度。
  - popup 按钮，文案同上，走 `sendToActiveTab({type: 'OPEN_RULE_PICKER'})`，发完 `window.close()`。
- **不做撤销**，删规则去设置页。

## 6. 旅程规格（e2e，一条旅程至少一个 spec）

B1 交付时，J-2、J-3、J-4 的后半、J-9、J-10 先以「夹具预置规则」的形式跑：直接往 `storage.sync` 写 `customRule:` 键，spec 标题带 `[fixture]`。B2 把 J-1 到 J-10 全部改成走真实入口（拾取器、设置页）；夹具版要么删掉，要么保留为隔离某个子步骤用，并标注清楚。

B2 终态：B1 的夹具 spec `test/e2e/custom-rules-fixture.spec.js` 已删除，J-1 到 J-11 的主用例全部只走真实入口。「从 SW 上下文直接写 / 删」的步骤是 `[fixture]` 子步骤，各自拆成单独的用例，标题带 `[fixture]`，注释写明隔离的是哪一步：
- J-4 第 3/3b 步（绕过设置页写入不安全 CSS）：`test/e2e/custom-rules-settings.spec.js` 的「[fixture] J-4 steps 3/3b」。主用例「J-4」只走第 1、2 步。
- J-8 的「另一台设备同步下来的删除」：`test/e2e/custom-rules-live.spec.js` 的「[fixture] J-8 synced delete」。测试里只有一个浏览器配置，没有真实入口能造出别的设备，所以这一下由 SW 直删；主用例「J-8」在设置页卡片里删。
- 拾取器遇到本站规则 CSS 不安全：`test/e2e/custom-rules-picker.spec.js` 的「[fixture] picker: when this site's rule has unsafe CSS…」，它要的正是一条设置页存不进去的规则。

J-7 的 49 条预置是前提，不是旅程步骤。J-11 在预览之后用同一份预置把额度占满，造的是「另一头同时在写」，导入本身走真实入口，不在此列。J-11 由 B2 交付，从一开始就走真实入口（P0-F 已合入，#110）。夹具主机一律用 `context.route` 路由的假主机；AI 走 `test/e2e/mock-openai-server.js`。

| # | 旅程 | 步骤 → 用户可观察结果 |
|---|---|---|
| J-1 | 拾取器排除（用户点名的旅程） | 夹具页含正文和评论区 `.comments`。点悬浮球「翻译」→ 正文和评论区都出现译文 → 打开悬浮菜单，「调整本站翻译区域」项的几何落在菜单盒内，菜单在视口内 → 点它 → 悬停评论区，描框与评论区 rect 一致 → 点击 → 工具条显示选择器和「匹配 1 处」→ 点「不翻译这里」→ 1 s 内评论区译文消失、正文译文仍在，并出现保存提示 → `storage.sync` 里恰好一个 `customRule:` 键，其 `exclude` 含该选择器 → 重载页面再翻译 → 评论区译文节点为 0，正文有译文<br>行内 exclude 这一步（B2，`test/e2e/custom-rules-picker.spec.js:150`）：用拾取器点中正文段落里的一个行内元素，点「不翻译这里」→ 重新翻译后，送到 mock AI 服务器的文本里没有它；**译文节点里也没有它**（这一条区分 exclude 和 keepOriginal）；原文里它照旧在 |
| J-2 | 保留原文 | 在设置页新建规则：匹配夹具主机，保留原文填 `.brand`（行内）和 `.code-name`（块）→ 保存 → 打开夹具翻译 → `.code-name` 块没有译文；含 `<span class="brand">BrandX</span>` 的段落有译文，且译文里原样出现 BrandX |
| J-3 | 只翻译这里 + 整页入口 | 夹具含 nav、main、aside，设置为 `pageTranslateScope: 'page'` → 用拾取器选 aside 里的 `.faq`，点「只翻译这里」→ 翻译 → 只有 `.faq` 有译文，nav 和 main 都没有 → 悬浮菜单里出现「翻译整个页面」，且几何在菜单盒内 → 点它 → 全页都有译文 |
| J-4 | 自定义 CSS 与安全 | 在设置页给夹具主机的规则写 CSS `.ai-translator-inline-block { color: rgb(1, 2, 3) !important }`（译文节点带行内颜色，不加 `!important` 改不动，见 §0.1-9） → 保存 → 另一个已打开并已翻译的夹具标签页里，1 s 内译文的计算色变为 `rgb(1, 2, 3)`，没有重载 → 在编辑器里追加 `body { background: url(http://127.0.0.1:<port>/leak) }` → 保存被拒，字段下出现 `customRuleCssUnsafe` 的文案，存储不变 → `[fixture]` 子步骤：从 SW 上下文直接往 `storage.sync` 写一条带这段 CSS 的规则（模拟绕过设置页的写入）→ 页面不应用它，mock 服务器收到的 `/leak` 请求为 0 |
| J-5 | 导出 / 导入 | 设置页已有规则 A → 点导出，下载的 JSON 里 `format`、`version`、`rules` 都正确 → 准备一个文件：A 改一个字段并设 `engine: 'ai'`，再加一条 `engine: 'ai'` 的新规则 B → 导入 → 预览显示「新增 1 条、替换 1 条」，并有 AI 提示（K = 2：替换的 A 也算，新增的 AI 规则只有 1 条） → 点「导入」→ 列表两条，A 为新内容 → 再导入一个坏 JSON → 报错，存储逐字节不变 |
| J-6 | 按站点引擎 | 全局的手动和自动引擎都是「内置」，不允许回退 → 设置页每日额度输入框为灰 → 新建规则，引擎选「我的 AI」→ 弹出确认框，文案为 `customRuleEngineAiConfirm` → 点取消，下拉框回到原值，规则没有保存 → 再选一次并接受 → 保存 → 额度输入框变为可用 → 站点设为「总是」→ 打开夹具 → 自动翻译的请求打到 mock AI 服务器，页面出现译文，今天的 AI 用量 > 0（从设置页的用量行或存储里读回）→ 在夹具页打开 popup → 引擎状态行是 AI 那一句，不是内置（popup 总是探测标签页，`probe.engine` 跟随站点，§3.7） |
| J-7 | 用量表 | 预置 49 条规则，体积接近 24 KiB → 设置页用量表显示对应的 KiB 数和「49 / 50」→ 再新建一条会超额的规则 → 被拒，出现 `customRulesBudgetFull` 的文案，存储不变 |
| J-8 | 跨标签即时生效 | 全局自动翻译关，夹具页手动点「翻译」→ 在另一个标签的设置页里新增一条排除规则 → 夹具页 1 s 内该区域译文消失，没有重载 → 在设置页里删掉这条规则（另一台设备同步下来的删除由 `[fixture]` 子步骤从 SW 上下文直删模拟，两条用例走同样的断言）→ 1 s 内夹具页该区域重新出现译文，靠的是 §3.6 第 3 步的增量那一轮 → 全局自动翻译开着再走一遍：手动点「翻译」后调度器接手这一页（`markPageExplicit`），加规则、删规则 → 该区域 1 s 内重新出现译文，这段文字在 mock AI 服务器上恰好被请求一次（第 3 步被 `isOn()` 挡住，只有第 5 步的重启在收块）；这次重译记在自动翻译的用量里（`autoStats.autoAiChars` 增量 > 0） |
| J-9 | iframe | 顶层夹具（主机 T）嵌一个 iframe（主机 F）。规则 A 匹配 F，exclude `.side-note`；规则 B 匹配 T，引擎 'ai'；全局引擎为内置 → 翻译 → iframe 里 `.side-note` 没有译文，其他段落有译文；iframe 里的段落文本出现在 mock AI 服务器的请求里。<br>• 引擎继承在自动模式、http 页面上验证（顶层与 iframe 都是 http 主机，不点「翻译」，靠自动翻译收块）。<br>• 手动路径区分不出来：子 frame 的手动轮把请求转给顶层，由顶层的引擎发出，子 frame 不继承也照样走 AI；https 也区分不出来：e2e Chromium 在 https 页面上有 `Translator`，内置引擎算可用，子 frame 没继承到 'ai' 也照样有引擎可用。http 页面没有 `Translator`，两张引擎开关都是内置、回退只许本地，除了从顶层指令继承来的 'ai'，子 frame 没有可用的引擎，没继承到就不出译文。<br>• 手动那一条只验区域按 iframe 自己的主机规则解析 |
| J-10 | 停住的页面被规则叫醒 | 全局的手动和自动引擎都是「内置」，不允许回退，站点设为「总是」→ 打开 http 夹具主机（http 上没有内置引擎，`effectiveEngine` 答 'none'，调度器停在 OFF）→ 页面保持原文，mock AI 服务器零请求 → 在另一个标签的设置页给这个主机新建规则，引擎选「我的 AI」并接受确认 → 保存 → 夹具页不重载，1 s 内出现译文，请求打到 mock AI 服务器。<br>额度用完停在 OFF 走的是同一段代码（`setStatus(OFF)` + `stopDiscovery()`，content-auto-translate.js :514-526）；那条路要内置引擎真能出译文，而 e2e 的无头 Chrome 里内置 `create()` 永不返回（`test/e2e/helpers.js` 的说明），所以不单列 |
| J-11 | 设置整份导出 / 导入带上规则（P0-F 接缝，§12.4） | 导入导出卡片的说明里列着「站点翻译规则」→ 设置页已有规则 A（引擎跟随全局）和 B（`engine: 'ai'`），全局的手动和自动引擎都是「内置」，不允许回退 → 用 P0-F 的整份导出 → 文件里 `customRules` 小节与卡片导出的对象逐字段相同 → 在卡片里删掉 A，把 B 的引擎改回跟随全局，每日额度输入框变灰 → 整份导入这份文件 → 预览里有一行「站点翻译规则：将新增 1 条、替换 1 条。」，警告里有 `customRulesImportAiNote` 那一句（K = 1：文件里 AI 规则 1 条，是替换的那条 B，新增的 AI 规则 0 条）→ 确认 → 卡片列表恢复两条，额度输入框变为可用 → 再整份导入一份规则小节超额的文件 → 不出预览，报「导入后「站点翻译规则」会超出同步空间，没有导入任何内容。」，存储逐字节不变 → 写入中途失败：删掉 A、B，整份导入原文件，预览出来后从 SW 上下文写入占满额度的规则（J-7 的预置），再点确认 → 报 `transferErrorApplyFailed` 那一句：停在「站点翻译规则」，原因是「超出同步空间」，「已导入」如实列出写进去的小节（至少有「设置」）；规则还是预置的那些，一条没多 → 两处报错里都不出现 i18n 键名 |

单测清单：

| 批 | 覆盖 |
|---|---|
| B1 | storage-writer：串行、'throw' / 'swallow'、`ITEM_BUDGET`、无 runtime 时的行为；另有一条守卫，`shared/` 与 `background/` 里不许出现第二个 `writeQueue` / `enqueue` |
| B1 | custom-rules：`validateRule`、`sanitizeCss` 表（每个禁用写法、`u/**/rl(`、`URL(` 大写、反斜杠转义、4096 上限）、`pick` 的三级平局、`applyChanges`、`mergeImport`（全有或全无、按合并后结果算额度、计数含 `aiCount`；有一条无效就整体抛 `customRulesImportInvalid`，`cause` 是那一条的具体原因）、`addSelector`（追加去重、新建时 `normalizeHost`）、额度三条上限、`newId` 格式 |
| B1 | sync-collection：`test/unit/sync-collection.test.mjs` 逐个覆盖 §2.6 表的成员，其中 `collect` 只从键取 id、值里带的不认，`write` 存进去的值不带 id，`usage` 按键名加值算，`write` 超额时抛的键与直接调 `assertFits` 相同；防抄写扫描（§2.6） |
| B1 | bootstrap 登记表（§1）：命中 `ctx.syncMirrors` 前缀的键交给那一项的 `onStorageChange`，不进 `ctx.settings`；没命中的照旧进；`content-bootstrap.js` 里不出现 `customRule:` 字面量 |
| B1 | 加载顺序（`site-rules.test.mjs` 的 `LOAD_ORDER` / `LOAD_LISTS`）；Node harness 先加载 storage-writer |
| B1 | 引擎（engine harness `test/unit/helpers/engine-harness.mjs`，D-303）：<br>• `isBuiltinSelected` 在有覆盖、无覆盖、覆盖为 null 时的取值；钉住时 `fallbackAllowed()` 为假；<br>• 站点钉内置 + http + `allow-ai`：返回 `{error, engine: 'builtin'}`，`effectiveEngine` 为 'none'，不发 sendMessage；<br>• 站点钉 AI + 自动请求：要过 `refuseAutoAiSpend`；<br>• `message.engine` 压过站点，两个方向都测；<br>• 站点钉内置时，只能走 AI 的类型在 http 和 https 上都到达 sendMessage；`BUILTIN_TYPES` 与 `handleWithBuiltin` 的 case 标签相等；<br>• `probeStatus().engine` 跟随站点 |
| B1 | 直读扫描（§3.7）：白名单外不许读 `engineFallback` / `translationEngine` / `autoTranslateEngine`；`EngineStatus.selectedEngine` 的取值（有 `probe.engine`、没有探测）；popup 的「没配 Key」拦截和 `describeEngineStatus` 都经过它 |
| B1 | 裸调用扫描（`auto-engine-choice.test.mjs`，§3.7）：正则放宽到任意接收者，`content/` 下零命中；`content-language-pack.js` 的两处都调 `inUse()`，`inUse()` 两半都问（源码断言，放在 `auto-translate-wiring.test.mjs` 现有的语言包那一条里） |
| B1 | custom-rule 的 `onChange` 签名门（vm 装载 `content/page/custom-rule.js`，桩掉 `chrome.runtime` 与 `SpaNavigation`）：别的主机的规则变了不回调；本页规则变了回调一次；换路由到另一条规则管的路径时回调，到同一条规则管的路径时不回调；子 frame `inherit` 同值不回调、换值回调 |
| B1 | 调度器接线（`test/unit/custom-rule-page.test.mjs`，「subscribers」与「is asked in one place」两条）：订阅 `ctx.customRules.onChange` 并调 `restart('custom-rule')`；`isOn()` 是 IDLE / RUNNING 判断唯一的一处，`frames/top.js` 与 §3.6 第 3 步都调它 |
| B1 | 规则先到：`whenReady()` 之前 `translatePage()` 不收块（`custom-rule-rounds.test.mjs`）；bootstrap 的 `ctx.init()` 在 `whenReady()` 之前不调 `setupAutoTranslate`（`custom-rule-page.test.mjs`，原样跑 `content-bootstrap.js`） |
| B1 | frames：`computeDirective` / `sameDirective` 含 `engineOverride`；子 frame `inherit(null)`；顶层订阅 `ctx.customRules.onChange(refreshDirective)` |
| B1 | scope：阶梯四档、include 零命中不缓存、`pageScopeStarts` include 分支三种情况、`outsidePageScope` |
| B1 | collect：行内 exclude 被拿掉、行内 keepOriginal 用占位符、块级 keepOriginal 压过 `translate="yes"` |
| B2 | picker selector：优先级、`isVolatileClass` 表、唯一性、5 层上限 |
| B2 | `auto-cost-gate`：确认助手的两个调用点，且只有一个 `window.confirm(`；`syncAutoEngineState` 并上 `customRulesUseAi()`，`unattendedAiReachable` 的函数体里没有规则项 |
| B2 | 导入预览（§4、§12.4）：`previewCustomRulesImport` 的返回值与抛错；`optionsSource()` 里卡片导入和 `TRANSFER_SECTIONS` 的 `customRules` 一行都调它，没有第二份合并或额度计算 |
| B2 | 整份导入的规则小节（§12.4，options 的 vm 装载）：`COLLECTION_REFUSALS` 的每个键在 10 种语言里都有文案，并且在 `shared/` 或 `background/` 的源码里以字面量出现（表里没有死键）；`validate` 遇到表里的键抛 `TransferError(报错码, 'customRules')`，`apply` 遇到表里的键抛以原因短语为 `message`、原错误为 `cause` 的 Error，表外的错误两处都原样抛出同一个对象；`transferErrorText` 对这两种情况给出的句子里没有键名；zh-CN 与 en 的 `transferDesc` 包含 `TRANSFER_SECTION_NAMES` 每一项的文案 |
| B2 | `host-css-containment`：新根节点在 `:is()` 列表里 |

### 6.1 承诺清单 → 断言

| 文案承诺 | 断言 |
|---|---|
| 「保存后立即生效」（拾取器提示、设置页说明） | J-1 / J-4 / J-8 / J-10：1 s 内生效、不重载；J-10 是已经停住的页面 |
| 「CSS 不能加载外部资源」（CSS 提示） | J-4：保存被拒；绕过设置页写进去的也不应用，mock 服务器零请求；单测清洗表 |
| 「自动翻译也会用你的 AI 接口，并计入每日额度」（确认框、导入预览、整份导入预览） | J-6：mock 服务器收到请求，AI 用量增加；J-5 / J-11：预览里的 K 与文件里 `engine: 'ai'` 的条数相同 |
| 「导入会替换同 id 的规则」（导入预览） | J-5 |
| 「规则跟着账号同步」（卡片说明） | J-1：键在 `storage.sync` 区；J-8：sync 区的外来变化 1 s 内生效 |
| 用量表「x KiB / 24 KiB · n / 50 条」 | J-7 |
| 「匹配 {n} 处」 | J-1（n = 1）、J-3 |
| 隐私政策新行「自定义站点翻译规则 … `chrome.storage.sync`」 | J-1：键在 sync 区 |
| 导入导出卡片说明「把设置、站点规则和站点翻译规则存成一个文件」（`transferDesc`） | J-11：整份导出的文件里有 `customRules` 小节，导回去规则恢复；单测：zh-CN 与 en 的说明包含每个小节名 |
| 整份导入报错「……没有导入任何内容」 | J-11：超额文件导入后存储逐字节不变 |
| 写入中途失败「……已导入：{written}」 | J-11：列出的小节正是写进去的那些，规则小节一条没写 |

## 7. 已知限制（写进 PR 与 backlog）

- 同一 URL 命中多条规则时不叠加，只有最具体的一条生效。
- include 在页面上零命中时回落到正文 / 整页，不会变成「什么都不翻」。
- 自定义 CSS 不进 shadow DOM。
- 拾取器够不着 iframe 里的元素（只在顶层工作），iframe 的规则只能在设置页写；closed shadow root 里的元素只能选到它的宿主。
- popup 打开得太早时（规则还没从后台回来，最多 1.5 s）显示的是全局引擎。
- 页面整体重写 `document.adoptedStyleSheets` 后，自定义 CSS 要等下一轮翻译或下一次规则变化才会回来。
- 内置规则表的保留原文用户撤不掉。
- 改引擎不会重译已有译文。
- 行内 exclude 的文字在「仅译文」模式下看不见：它不在送出的原文里，所以也不在译文里。
- CSS 里的反斜杠一律拒绝，`content: "\201C"` 这类合法写法也在其列（提示里说明，请改用字面字符）。
- 自定义 CSS 改颜色、字号这类属性要加 `!important`：译文节点带着从原文复制来的行内样式（清单见 §0.1-9）。兄弟译文的 margin-bottom、图标缩进的起始边 padding、flex 译文的起始边 margin 本身是带 `!important` 的行内声明，用户 CSS 改不了。
- 悬停翻译与划词翻译不受行内 exclude / keepOriginal 影响：规则只作用于整页翻译的收块；悬停路径里的原样占位符只来自页面自己的 `translate="no"`。
- 内置规则表（D-315，只有 keepOriginal）命中整块时整块不翻；命中块内行内元素时，那段文字经占位符原样带回译文。一个选择器命中的是行内元素还是整块，除了标签本来就是行内的以外，都取决于站点当时的模板，站点改版可能由行内变整块，或者反过来。
- 内置规则表的 keepOriginal 选择器逐条（`shared/site-rules-builtin.js`）。判断依据分三类：**A** 标签本来就是行内的，确定；**B** 按站点模板推断，没有在线核实过，以站点当前模板为准；**C** 由页面结构决定，页面变了它就变，以站点当前模板为准。
  - arXiv 摘要页（:53）：`.authors`、`.dateline`、`.submission-history` 为整块（B）。
  - arXiv HTML 全文（:95）：`.ltx_authors`、`.ltx_bibliography` 为整块（B）。
  - arXiv 列表页（:108）：`.list-authors`、`.list-identifier`、`.list-subjects` 为整块（B）。
  - x.com / twitter.com（:142 / :149）：`[data-testid="User-Name"] a` 为行内（A，链接）；`time` 为行内（A）；`[role="group"]` 为整块（C，操作栏容器）。
  - reddit.com（:163-166）：`time`、`faceplate-timeago` 为行内（A）；`.tagline`、`.score` 视模板为行内或整块（B）；`[slot="credit-bar"]`、`[slot="commentMeta"]` 为整块（C，slot 分发到的容器）。
  - news.ycombinator.com（:174）：`.subtext` 为整块（B）；`.rank`、`.age` 为行内（B，今天的模板里是 span）。
  - lobste.rs（:185）：`.byline` 为整块（B）；`.tags` 为行内容器（B）。
  - bioRxiv / medRxiv（:198）：`.highwire-cite-authors`、`.highwire-cite-metadata` 为整块（B）。
  - nature.com（:209-215）：`.c-article-author-list`、`.c-article-references`、`.c-bibliographic-information`、`.c-article-info-details` 为整块（B）；`#author-information-content` 为整块（C，按 id 找区块）。
  - science.org（:237-243）：`.contributors`、`.core-self-citation`、`.core-authors` 为整块（B）；`#bibliography`、`#tab-citations` 为整块（C，按 id 找区块）。
  - scholar.google（:282）：`.gs_a`、`.gs_fl` 为整块（B）。
  - arXiv PDF 页与 Hugging Face 两条没有 keepOriginal 选择器。

## 8. i18n

全部新键都进 `i18n/lang/*`（10 种语言）。B1 不新增用户可见文案。

| 键 | 用途 |
|---|---|
| `customRulesTitle` / `customRulesDesc` / `customRulesAdd` / `customRulesEmpty` / `customRulesUsage` | 卡片标题、说明、新建、空态、用量表 |
| `customRulesExport` / `customRulesImport` / `customRulesImportPreview` / `customRulesImportAiNote` / `customRulesImportConfirm` / `customRulesImportInvalid` | 导出与导入 |
| `customRuleMatch` / `customRuleInclude` / `customRuleIncludeHint` / `customRuleExclude` / `customRuleKeepOriginal` / `customRuleCss` / `customRuleCssHint` / `customRuleEngine` / `customRuleEngineFollow` | 编辑器字段；列表里的字段小标签也用这几个标签键，没有自己的一套。引擎的另两个选项复用 `autoTranslateEngineBuiltin` / `autoTranslateEngineAi` |
| `customRuleEdit` / `customRuleDelete` / `customRuleDeleteConfirm` / `customRuleSave` / `customRuleCancel` | 行内按钮；「保存」「取消」若已有通用键就复用，交付时列出。B2 交付：没有通用的保存 / 取消键（现有的 `comicCancel`、`transferCancel` 都属于各自的功能），所以新增 `customRuleSave` / `customRuleCancel` |
| `customRuleInvalid` / `customRuleCssUnsafe` / `customRuleMatchInvalid` / `customRuleSelectorInvalid` / `customRuleTooLarge` / `customRulesBudgetFull` / `customRuleSaveFailed` | 错误 |
| `customRuleEngineAiConfirm` | 确认框 |
| `pickSiteRegion` | 悬浮菜单项和 popup 按钮 |
| `pickerHint` / `pickerMatches` / `pickerParent` / `pickerExclude` / `pickerKeepOriginal` / `pickerInclude` / `pickerCancel` / `pickerSaved` / `pickerExcludeTip` / `pickerKeepOriginalTip` / `pickerCssUnsafe` | 拾取器。两条 Tip 是按钮下的说明，设置页编辑器的两个字段也用（§5.1）；`pickerCssUnsafe` 是本站规则 CSS 不安全时拾取器的报错 |
| `transferSectionCustomRules` / `transferPreviewCustomRules` / `transferErrorSectionInvalid` / `transferErrorSectionBudgetFull` / `transferReasonInvalid` / `transferReasonBudgetFull` / `transferReasonSaveFailed`，以及改 `transferDesc` | 设置整份导入导出里的规则小节（§12.4） |

## 9. 文件归属与切批

| 文件 | B1 | B2 |
|---|---|---|
| 新增 `shared/storage-writer.js`、`shared/sync-collection.js`、`shared/custom-rules.js`、`content/page/custom-rule.js` | ✔ | — |
| `shared/site-rules.js`、`shared/auto-stats.js` | 改用 StorageWriter；site-rules 补导出 `hostMatches` / `patternMatches` / `validPattern`（§1） | — |
| `background/background.js`、`background/ai-translate.js`、`background/api-client.js`、`background/custom-rules-host.js` | import 顺序、分派表、两个新消息 | — |
| `manifest.json` | 四个新文件入表 | `content/picker/*`、`content/css/rule-picker.css` 入表 |
| `content/page/site-adapter.js`、`collect.js`、`notranslate.js`、`scope.js` | ✔ | `collect.js:321` 自家 UI 列表加拾取器根 |
| `content/content-translation-engine.js` | 谓词 `isBuiltinSelected` / `fallbackAllowed`、`BUILTIN_TYPES`、`whenReady`、预算注释、导出 `fallbackAllowed`（§3.7） | — |
| `content/frames/top.js`、`content/frames/child.js` | `engineOverride`；顶层 `currentTranslate()` 改用 `isOn()`，订阅 `ctx.customRules.onChange(refreshDirective)`（§3.8） | — |
| `content/content-auto-translate.js` | 导出 `isOn()`；订阅 `ctx.customRules.onChange`，调 `restart('custom-rule')`（§3.6） | — |
| `content/captions/translate.js`、`content/content-language-pack.js` | `isActive(false)` 加 `fallbackAllowed()`；`inUse()`（§3.7） | — |
| `shared/engine-status.js` | 新函数 `selectedEngine(settings, probe)`（§3.7） | — |
| `content/content-bootstrap.js` | 登记表 `ctx.syncMirrors` 转发增量（§1）；init 等 `whenReady` | — |
| `content/content-float-ball.js` | `showWholePage` 的条件 | 菜单项 |
| `content/content-messaging.js` | — | `OPEN_RULE_PICKER` |
| `options/options.html`、`popup/popup.html` | 脚本表（options 加 storage-writer、sync-collection、custom-rules 三个 shared 文件，popup 只加 storage-writer） | options 新卡片与脚本；popup 按钮 |
| 新增 `content/picker/{selector,toolbar,picker}.js`、`content/css/rule-picker.css`、`options/options-custom-rules.js` | — | ✔ |
| `options/options-auto.js`、`test/unit/auto-cost-gate.test.mjs` | — | 确认助手；`syncAutoEngineState` 并上规则项 |
| `options/options-transfer.js`（P0-F 所有） | — | `TRANSFER_SECTIONS` 加 `customRules` 一行、`TRANSFER_SECTION_NAMES` 加一行、`TRANSFER_ERROR_KEYS` 加两行；新增 `COLLECTION_REFUSALS`、`TRANSFER_REASON_KEYS` 两张表和行工厂 `collectionSection`（§12.4） |
| `popup/popup.js` | 总是探测标签页；「没配 Key」拦截改用 `EngineStatus.selectedEngine`（§3.7） | 按钮 |
| `content/css/popup.css` | — | `:is()` 列表 |
| `i18n/lang/*`（10 种） | — | ✔ |
| 文档：`CHANGELOG.md`（顶部 `## Unreleased`）、`README.md`、商店文案、`docs/privacy-policy.md`、`CLAUDE.md` | — | ✔ CLAUDE.md 要做三件事：新增「User Site Rules」一节（解析器、键布局、StorageWriter）；「three unattended AI paths」改成 four；样式表数量按 A 整合后的实数加 1 |
| 加载清单守卫 | 按新增文件同步 `test/unit` 里所有 load-list 守卫，以及 e2e 的 `PAGE_TRANSLATION_MODULES` / `contentHarnessScripts` | 同左 |
| 单测 | §6 单测表的 B1 行，含新增 `test/unit/sync-collection.test.mjs`，以及改 `auto-engine-choice.test.mjs`、`auto-translate-wiring.test.mjs`、`engine-status.test.mjs` | §6 单测表的 B2 行 |

不碰：`content/page/insert.js`（P0-C，只调用 `ctx.releaseTranslation`）、`content/content-selection.js` / `content/content-popup.js`（P0-D）、`background/commands.js`（P0-C）、目标语言、语言列表与 RTL（P0）、`pdf/`（P0）、`shared/api-compat.js` 与后台 Key 检查（P0-A）、`options/options-transfer.js` 里除 §12.4 列出的几样以外的部分与 `onboarding/`（P0-F）、`options/options-sync-mirror.js`（P0-B）。

与 P0-D 同改的两个文件：`content/content-translation-engine.js` 和 `popup/popup.js`。P0-D 已合入（#111），B1 直接在 main 上改。

## 10. 门禁

```bash
npm --prefix <W> run test:unit > <log> 2>&1; echo "GATE unit exit=$?"
npm --prefix <W> run test:e2e > <log> 2>&1; echo "GATE e2e exit=$?"
```

两门都是 0 才算绿，另按日志里 ✘ 的个数核对。不接 `| tail`（退出码会变成 tail 的）。`<W>` 是 worktree 的绝对路径。e2e 全量约 18 分钟，超过工具的超时，用 `nohup sh -c "...; echo \"GATE e2e exit=\$?\" >> <log>" > /dev/null 2>&1 &` 脱离后台跑，跑完读日志。已知偶发：`test/e2e/selection-popup-pronunciation.spec.js` 连真实的 `https://example.com`，网络抖动时 `page.goto` 报 `net::ERR_ABORTED`；遇到时单独重跑这个文件三次，全过记为偶发并附日志。

## 11. Backlog（本轮登记，不做）

- 拾取器撤销（在保存提示里放「撤销」）。
- 多条规则叠加。
- 在 iframe 里拾取（同源 frame）。
- 自定义 CSS 注入 shadow DOM。
- 按规则选模型 / 配置档（等 P1-D）。
- 规则市场 / 订阅。
- P1-B·style：按站点译文样式（等 #105）。
- 改引擎后重译已有译文。
- 允许撤销内置规则表的保留原文。
- closed shadow root 内拾取（`chrome.dom.openOrClosedShadowRoot` 加 `elementsFromPoint`）。

## 12. 接缝

### 12.1 与 P1-A（#107，已合入 64f2b2a）

- **B 负责的 P1-A 文件改动**：`scope.js` 在 `:56` 之后插入 include 一档（注释 #107 已写好）、`collect.js:506` 的条件。#107 已合入，不和 A 抢同一份文件。
- **#107 已处理**：
  - 子 frame 照传 null 的 `scopeOverride`，设和清都跟顶层（`child.js:169-174`）；
  - `child.js` 手动一轮的回落分支已收掉，只走 `ctx.collectPageBlocks()`（`:131`）；
  - B-P0C-4：`#ai-translator-source-peek` 已进 collect 排除（`collect.js:321`）；
  - D-294 #1：`content/` 下已没有 `:host-context`。
- **B-P1A-9 已在 #107 里做完**（rebase 到 `main@8d5e8df` 之后的 `d5d268b`）：
  - D-294 #4：Alt+W 是 P0-C `background/commands.js` 里 `COMMANDS` 表的一行，经 `runCommand` 触发；
  - 悬浮球菜单自己量高度（`content-float-ball.js` 读 `floatMenu.offsetHeight`），不再按 `showWholePage ? 40 : 0` 估；
  - 三处替身都换成了真东西。
  - B1 在 `content-float-ball.js` 里改「`showWholePage` 的条件」（§9）。
- 本节行号已按 `main@a99435d` 核对（D-314）。
- **B 依赖 A 的名字**：`ctx.collectPageBlocks`、`ctx.invalidatePageScope`、`state.pageScopeOverride`、`ctx.frames.onVisibilityChanged`、`closestAcross`、`queryAllDeep`、`installStyle` / `hasStyle`、`computeDirective` / `sameDirective` / `applyDirective`，以及 D-303 用到的 `ctx.autoTranslate.restart`（content-auto-translate.js 的导出 `restart: start`，B2 终态在 :845）、`ctx.autoTranslate.onStateChange`、`refreshDirective`（top.js:74-80）。A 若再改其中任何一个，B 的任务书跟着改。

### 12.2 与 P0-D（#111，已合入）

- `message.engine` 的优先级最高，其次站点，最后设置（§3.7）。钉住落在谓词层，`pinnedEngine` 和它那行抛错都不动，P0-D 的代码不用改；D-302 第 3～6 条发给 P0 的内容仍成立。
- 同改两个文件：`content/content-translation-engine.js` 和 `popup/popup.js`。P0-D 已合入，B1 直接在 main 上改（§9）。
- `wantsBuiltin` 注释里「将来加在这里」（:611）改成指向谓词，由 B1 改。

### 12.3 与 P1-C 术语表

- P1-C 的词表建在 `SyncCollection` 上（§2.6），不另写读、写、缓存和增量；防抄写扫描同时管住 custom-rules 和 glossary。
- sync 额度表（§2.1）已给 `glossary:*` 留出 ≤ 32 KiB、≤ 300 条。
- 词表的站点作用域用 `SiteRules.hostMatches`，靠 B1 补上的导出（§1）。
- 规则的 `domain` 字段（按站点选领域）由 P1-C 的 C3 加进规则结构，B1 不预留。按 §2.2 的版本规则，带 `domain` 的规则写成 `v: 2`，不带的仍是 v1。只装了 B1 的版本写入时丢弃未知字段，但它会跳过 v2 的规则，所以不会在拾取器 `addSelector` 或设置页保存时把 `domain` 丢掉。B1 与 C3 之间发没发过商店版本都这样做，不设条件。
- 词表变化时，内容脚本也要按「本页生效的集合变了才回调」来门控，做法和 §3.1 的签名门一样。
- 词表前缀在每个 frame 都登记进 `ctx.syncMirrors`，只有顶层建镜像（§1），建时传顶层主机（`mirror({request, host})`，§2.6）；`whenReady()` 的 1500 ms 上限写在 `SyncCollection.mirror` 里，两边共用（§2.6）。

### 12.4 与 P0-F（设置整份导入导出，`options/options-transfer.js`）

本节按 P0-F 合入后的实际接口写，行号按 `main@a99435d` 核对（D-306 写、D-314 对锚）。

- **P0-F 的契约**（`options/options-transfer.js:11-26` 的注释是原文）。`TRANSFER_SECTIONS`（:121）每行 `{key, collect, validate, preview, apply}`：
  - `collect({includeApiKey})` 给出这一小节的值；
  - `validate(raw)` 可以是 async，返回 `{value, accepted, dropped}`，别的字段原样带给 `preview`；整个小节不能要时抛 `TransferError(code, 小节键)`，整份文件都不导入；
  - `preview(result)` 返回 `{lines, warnings}`；
  - `apply(value)` 失败就抛。

  `SettingsTransfer.validateAll`（`shared/settings-transfer.js:226-237`）按表的顺序校验完所有小节，全部 `accepted === 0` 时报 `nothingValid`。`applyAll`（:246-261）按表的顺序写，跳过 `accepted === 0` 的小节；第一处失败就停，抛 `TransferApplyError(已写入, 失败的小节, 原错误)`，不回滚。文件里有、当前版本不认识的小节在预览里列出来。报错句由 `transferErrorText`（options-transfer.js:165-178）给出：`TransferError` 按 `TRANSFER_ERROR_KEYS`（:155）取句子，只填 `{section}`；`TransferApplyError` 用 `transferErrorApplyFailed`，其中 `{message}` 填原错误的 `message`；其余一律 `transferErrorUnexpected`。
- **B2 加 `customRules` 一行**，排在 `siteRules` 之后（P0 已同意由 P1 在自己的 PR 里加）：
  - `collect`：`CustomRules.toExportFile(全部规则)`，即 §0.1-16 的对象，小节的值就是它，不另包一层；
  - `validate(raw)`：`await previewCustomRulesImport(raw)`，与卡片导入预览是同一个函数（§4），返回 `{value: raw, accepted: added + replaced, dropped: [], added, replaced, aiCount}`。集合的导入全有或全无，所以 `dropped` 恒为空；
  - `preview`：一行 `transferPreviewCustomRules`（「站点翻译规则：将新增 {added} 条、替换 {replaced} 条。」）。`aiCount > 0` 时，`warnings` 里放卡片那一句 AI 提示（`customRulesImportAiNote`，K 的算法相同）；这句话由卡片和这一行共用的一个函数产出，不在两处各填一次；
  - `apply(value)`：`CustomRules.request('import', {file: value})`，走 §2.4 的 `import`，原样传解析后的对象，不 stringify。
- **小节名**：`TRANSFER_SECTION_NAMES`（:146）加 `customRules: 'transferSectionCustomRules'`，文案与卡片标题相同：「站点翻译规则」/ "Site translation rules"。
- **集合的拒绝怎么告诉用户**。集合报错时抛 `Error(<i18n 键>)`（§2.3、§2.4），那些句子是写给卡片的，放不进整份导入的两种句式：`transferErrorText` 不认识这些键，校验时会落成「出错了：customRulesBudgetFull」；写入时 `{message}` 会原样填进键名。所以 P1 在 options-transfer.js 里加三样东西，P1-B 和 P1-C 两行共用：
  1. 表 `COLLECTION_REFUSALS`：集合的错误键 → 报错码。

     | 错误键 | 报错码 |
     |---|---|
     | `customRulesImportInvalid`、`customRuleTooLarge` | `sectionInvalid` |
     | `customRulesBudgetFull` | `sectionBudgetFull` |
     | `customRuleSaveFailed` | `sectionSaveFailed`（只在写入时出现） |

     P1-C 的 C2 往同一张表里加词表的键（P1-C 文档 §12）。
  2. 报错句与原因短语。`TRANSFER_ERROR_KEYS` 加两行：`sectionInvalid: 'transferErrorSectionInvalid'`（「文件里「{section}」这一部分有无效条目，没有导入任何内容。」）和 `sectionBudgetFull: 'transferErrorSectionBudgetFull'`（「导入后「{section}」会超出同步空间，没有导入任何内容。」）。另加表 `TRANSFER_REASON_KEYS`，把报错码映射成写入中途失败时的原因短语：`transferReasonInvalid`「有无效条目」、`transferReasonBudgetFull`「超出同步空间」、`transferReasonSaveFailed`「没能写入同步存储」。
  3. 行工厂 `collectionSection(spec)`，包住一行的 `validate` 和 `apply`：
     - 表里的键，在 `validate` 里换成 `TransferError(报错码, 小节键)`；在 `apply` 里换成 `Error(<原因短语>, {cause: 原错误})`，于是 `transferErrorApplyFailed` 读出来是「导入在「站点翻译规则」这一步停下：超出同步空间。已导入：……」；
     - 表外的错误在两处都原样往上抛（同一个对象），由 P0-F 现有的两处 catch 各记一次日志（`Settings import rejected:` / `Settings import failed:`）；
     - 卡片自己的导入照旧直接显示集合的句子。

  按排期 B2 先合，由 B2 建这三样；若 C2 先合，就由 C2 建，另一方只加自己的行。
- **`transferDesc` 是一条承诺**：「把设置和站点规则存成一个文件……」列的是文件里有什么。B2 把 10 种语言的 `transferDesc` 都补上「站点翻译规则」，C2 再补「术语表」。单测：zh-CN 与 en 的 `transferDesc` 不分大小写地包含该语言里 `TRANSFER_SECTION_NAMES` 每一项的文案。
- AI 同意：整份导入同样不弹确认框，前提是整份预览里出现同样的 AI 提示。规则小节用卡片同一行 `customRulesImportAiNote`，K 同算法；设置小节在导入后的设置会打开一条现在关着的无人值守 AI 路径时，出现与 `autoTranslateEngineAiConfirm` 同一句话（P0-F 实现：`unattendedAiReachable(settings)` 对导入前后各算一次）。
- 预算格：B2 不往 `unattendedAiReachable` 里并规则项，规则项放在 `syncAutoEngineState()`（§0.1-19、§4）。
- `shared/site-rules.js`：P0-F 已在 `WRITES`（:564）末尾加了 `import`（载荷 `{map}`），另加一行 `importUserRules(map)` = `request('import', { map })`（:595-596），没动 `applyWrite` / `request` / `enqueue` 的函数体。B1 把队列搬进 StorageWriter 时 `WRITES` 原地留下，P0-F 的条目照常生效。三份集合的导入是同一个动词：`import {map}` / `import {file}` / `import {csv}`（P1-C 词表）。
- `background/background.js`：P0-F 的 onInstalled（:289-297）只在 `reason === 'install'` 时打开 `onboarding/`，与 B1 的分派表不重叠。P0-F 顺带改 README 的批量数字和 CLAUDE.md 的并发描述，B 不动 `batch.js` 的常量。
