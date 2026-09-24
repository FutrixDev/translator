# P1-B 用户站点规则：翻译范围 / 排除 / 保留原文、自定义 CSS、按站点引擎、页内拾取器、导入导出

- 日期：2026-09-24
- 基线：`origin/main@8a10465`（manifest 1.4.0）；分支 `feat/p1-b-site-rules@c98d4ca`（= 8a10465 + P1-A 两个文档提交）
- 行号口径：不标注的 = `8a10465`；标「A1」的 = `feat/p1-a1-frames@3102fcb`；标「A2」的 = `feat/p1-a2-shadow-scope@6a369ba`。P1-A 整合后，任务书按整合结果重新对锚
- 所属：P1 功能对标回合（台账 D-291），本设计的自决登记为 D-296
- 交付：一个 PR `feat/p1-b-site-rules`，由两批串行拼装——B1 数据层与页面接线、B2 入口与界面。合并顺序在 P1-A 之后（A 若 squash 合入，B 用 `rebase --onto` 接上）。「按站点译文样式」拆成 P1-B·style，等 #105 合入后再做（D-294 #2）

## 0. 结论

今天用户对一个网站只能说「总是翻 / 从不翻」（`siteRules`，`shared/site-rules.js`）。至于这个站点翻哪一块、哪一块别碰，只有内置适配器说了算（`content/page/site-adapter.js:51`），用户改不了。沉浸式翻译允许用户按站点写选择器、写 CSS、换引擎，还能在页面上直接点选。

这一轮在设置页加一张「站点翻译规则」卡。每条规则由两部分组成：一组 `host[/path-glob]` 匹配模式，加上下表字段中的至少一个。匹配语法沿用 site-rules 已有的模式助手：主机按后缀匹配（覆盖子域），主机里不许出现 `*`，路径可以带 glob。

- **入口**有两个：设置页的编辑器；页内拾取器（悬浮球菜单一项，外加 popup 一个按钮）。
- **存储**：`chrome.storage.sync` 里每条规则一个键 `customRule:<id>`，跟着账号同步；另提供 JSON 导出和导入。
- **解析**：页面侧只有一个解析器 `shared/custom-rules.js`，用户规则优先于内置适配器；`SiteRules.decide()` 一行不改。

| # | 能力 | 边界（刻意不做的） |
|---|---|---|
| 1 | **翻译范围 / 排除 / 保留原文**：include、exclude、keepOriginal 三组选择器 | 同一 URL 命中多条规则时不叠加，只取一条（§0.1-5）；内置适配器的 exclude 用户撤不掉 |
| 2 | **自定义 CSS**：作用于本站页面，用 constructable stylesheet 注入 | 不进 shadow DOM；凡是会发网络请求的写法一律拒绝 |
| 3 | **按站点引擎**：可选内置 / 我的 AI / 跟随全局 | 不能选模型或配置档（归 P1-D） |
| 4 | **页内拾取器**：悬停描框、点选、「↑上一层」、选择器可编辑、实时显示命中数 | 只在顶层 frame 工作；没有撤销，删规则去设置页 |
| 5 | **设置页**：规则列表、编辑器、用量表、导出/导入 | 没有规则市场 |
| 6 | **一个解析器，用户优先** | `SiteRules.decide()` 不变，自动翻译的「总是 / 从不」判断照旧 |

### 0.1 自决（台账 D-296 已登记，此处给依据）

| # | 裁定 | 依据 |
|---|---|---|
| 1 | **键布局**：每条规则单独一个 sync 键 `customRule:<id>`。`siteRules` 不动。不设索引键，读全部规则一律用 `get(null)` 再按前缀过滤 | sync 单项上限 8 KiB（JSON 加键名），把所有规则塞进一个数组键很快就会撞顶。sync 按键合并，两台设备各改各的规则互不覆盖。索引键在两台设备同时新增规则时会互相覆盖，结果是规则还在、却列不出来。最低支持的 Chrome 116 没有 `getKeys()`（Chrome 130 才有），只能用 `get(null)` |
| 2 | **额度**：单条 ≤ 6 KiB（按 `itemBytes` 口径计），全部规则合计 ≤ 24 KiB 且 ≤ 50 条。检查放在 SW 写队列里，超额就拒绝，不做截断 | sync 总额 100 KiB，要分给设置、`siteRules`、询问计数、P1-C 词表和 P1-D 配置档，分法见 §2.1 额度表。截断会在用户不知情时丢掉他写的选择器 |
| 3 | **抽出 `shared/storage-writer.js`**（`globalThis.StorageWriter`）。`create({type, writes, errors})` 返回 `{applyWrite, request}`。它统一持有 `IN_SERVICE_WORKER` 判断、每个 writer 一条队列、`itemBytes`、`ITEM_BUDGET = 6 * 1024`（从 site-rules 的 `MAX_ITEM_BYTES` 搬过来）。site-rules、auto-stats、custom-rules 三家共用 | 「SW 单写者队列」这是第三次出现。前两份（`shared/site-rules.js:413-438/:536-557`、`shared/auto-stats.js:166-176/:222-247`）已经是同一段代码抄了两遍，再抄第三遍正是 CLAUDE.md「Shipping Changes」第 2 条说的漂移。两家对错误的处理本来就不同，所以做成参数：site-rules 出错时抛出，auto-stats 吞掉错误回 null |
| 4 | **读取**：内容脚本不调 `get(null)`，也不镜像全部规则。SW 应答 `CUSTOM_RULES_FOR_HOST`，host 取 `sender.url`。之后内容脚本只吃 `storage.onChanged` 里 `customRule:` 键的增量。设置页读全部 | 沿用只读需要的键的既有做法（`content/content-bootstrap.js:131-133` 只镜像设置键）。一个页面只关心自己主机的那几条规则 |
| 5 | **胜出规则**：同一 URL 命中多条时只取一条。先比命中模式串的长度，最长者胜；一样长时取 `updatedAt` 较新的；再一样取 id 较小的 | 叠加的语义用户既看不见也猜不到：两条规则的 include 该取并集还是交集？CSS 谁在前？「最具体的赢」是 CSS 优先级、路由表、site-rules 共同的直觉 |
| 6 | **与内置适配器合并**：atomic 只来自内置；exclude = 内置 ∪ 用户；keepOriginal、include、CSS、引擎只来自用户 | atomic 是内置适配器针对特定 DOM 调出来的整块翻译，不向用户开放。exclude 取并集，保证内置排除（多半是登录框、代码块）不会被一条用户规则意外放开 |
| 7 | **exclude 与 keepOriginal 的分工**。exclude 表示不翻译、也不送出：命中块则跳过整块；命中块内的行内元素，则把它的文字从原文里拿掉。keepOriginal 表示不翻译、但原样保留：命中块则跳过整块，且在 translate judge 之前判定；命中行内元素，则按 `translate="no"` 处理，送出占位符，译文里原样出现 | 照搬沉浸式翻译 `excludeSelectors` / `stayOriginalSelectors` 的分工，用户从那边迁过来的规则语义一致。行内保留复用 A2 的 notranslate 占位符（A2 collect.js:710-714），不另造机制。块级 keepOriginal 在 judge 之前判，所以页面里的 `translate="yes"` 重开不了它：用户规则优先于页面声明。行内 exclude 的新行为对内置适配器的 exclude 同样生效，实现时要把内置规则里会命中行内元素的选择器列出来，作为偏差申报 |
| 8 | **范围阶梯**，从高到低：临时「整页」覆盖 → 用户 include（至少命中一个已渲染元素）→ 设置为 'page' 或 `matchBuiltin` 命中 → 'main'。include 零命中时不缓存结果 | 「翻译整个页面」是用户当下的明确动作，应当压过一切。include 是用户专门为这个站点写的范围，比全局设置和内置规则更具体。零命中时往下回落：站点改版后选择器失效，不能让整页一个字都不翻。零命中不缓存：SPA 的正文常常晚于首轮渲染 |
| 9 | **CSS 注入方式**：只用 constructable `CSSStyleSheet`，挂到 `document.adoptedStyleSheets`，没有 `<style>` 退路（D-297 修订 D-296 第 6 条）。不用 `chrome.scripting.insertCSS` | `insertCSS` 需要 `scripting` 权限，本轮不加新权限。A2 已经用过同一手法（`content/page/shadow.js` 的 `installStyle`，整合批同样删掉了它的 `<style>` 退路）。adopted sheet 排在文档样式表之后，同等特异度时用户 CSS 胜出。只留一条路径：最低版本 Chrome 116 上两个 API 都在，构造或挂载失败只可能来自页面环境异常，这时应当打日志让它被看见，而不是悄悄换一条没人测的路 |
| 10 | **CSS 清洗**。先去掉注释，再不区分大小写地查以下写法，出现任何一个就拒绝：`url(`、`image-set(`、`image(`、`cross-fade(`、`src(`、`attr(`、`@import`、`@font-face`，以及任何反斜杠。长度 ≤ 4096 字符。SW 写入时查一遍，内容脚本应用前再查一遍。只拒绝、不改写 | 规则会经 sync 和导入文件流转，导入的文件可能出自别人之手。CSS 里一切能发请求的构造都能把页面信息带给第三方，「属性选择器 + 背景图」就是已知的 CSS 外泄手法。反斜杠转义能拼出任意关键字，所以一律拒绝。先去注释是为了防 `u/**/rl(` 这种拼接。只拒不改，保证用户看到的就是实际生效的。内容侧再查一遍，是因为 sync 里的数据不一定都经过本机 SW。代价是 `content: "\201C"` 这类合法写法也会被拒，提示文案里要说明 |
| 11 | **引擎覆盖**：手动、自动、无人值守三类请求都认，`effectiveEngine` 也反映覆盖结果。规则选了 'ai' 但没配 Key 时，走现有的「没配 Key」路径。预算闸的代码不改，只改它上面的注释 | 引擎是按站点的偏好，用户说「这个站点用 AI」时，不会区分是点出来的翻译还是自动的。自动和无人值守请求照旧带 `auto` / `unattended` 标记，过闸时照样扣额度；只是能走到闸前的组合多了一种，注释跟着改 |
| 12 | **frames**：`engineOverride` 加进顶层指令，子 frame 照单继承。选择器与 CSS 按子 frame 自己的 URL 解析 | 这是 A1 偏差 #7 附带的约束：子 frame 本地回答 `effectiveEngine` / `isActive`。有了按站点引擎后，子 frame 必须跟随顶层 frame 的规则，否则一个页面会出现两种引擎。选择器和 CSS 作用于 DOM，只对子 frame 自己的文档有意义。实际执行本来就在顶层（A1 偏差 #15） |
| 13 | **规则变更即时生效**（≤ 1 s，不用重载） | 拾取器的价值就在「点完立刻看到」。要重载才生效的编辑器，用户会以为没保存。增量去抖 150 ms 再加一轮收块，远低于 1 s |
| 14 | **拾取器生成的选择器**只要求在它自己的 root 里唯一。优先级：id > 稳定的 `data-*` > 标签 + 非哈希类名（`isVolatileClass` 判定）> `nth-of-type` 链，最多 5 层 | 规则会存下来长期复用，所以要挑最不容易随站点构建变化的写法。id 和 `data-*` 是站点作者手写的，最稳。CSS Modules、styled-components 生成的哈希类名每次构建都会变，不能用。`nth-of-type` 链最脆弱，排在最后，并限制在 5 层以内 |
| 15 | **入口**：悬浮球菜单加一项，popup 加一个按钮；不加快捷键 | 拾取是低频动作。Chrome 对 `commands` 的建议键最多只给 4 个，已用了 Alt+A 和 A2 的 Alt+W，剩下的留给更高频的功能 |
| 16 | **JSON 格式**：`{format:'blab-site-rules', version:1, exportedAt, rules}`。导入按 id 合并，全有或全无；额度按合并后的结果检查；写入用一次多键 `set`；导入的规则 `updatedAt` 一律记为当前时间 | 有 `format` 和 `version`，导入时一眼就能拒掉别的文件。按 id 合并，「导出 → 改 → 导入」就是幂等的。全有或全无，避免导入一半后用户不知道哪些进去了。多键 `set` 只算一次写（sync 每分钟上限 120 次）。`updatedAt` 取当前时间，是让刚导入的规则在平局时胜出，符合用户预期 |
| 17 | **译文样式**（style）挪到 P1-B·style | 译文样式要在所有 frame 生效，得等 #105 的 `ctx.applyTranslationDisplay()` 覆盖所有 frame（D-294 #2）。「自己写样式」的需求，本轮的自定义 CSS 已经覆盖 |
| 18 | **切批**：B1 在前、B2 在后，串行，合成一个 PR | B1 是数据层和页面接线，没有界面，用夹具预置规则来验证。B2 是全部入口和界面。两批改的文件几乎不相交，唯一交集是悬浮球，且改的是不同 hunk。但 B2 的旅程依赖 B1 的行为，所以只能串行。B1 单独上线用户什么也看不见，所以不单独开 PR |
| 19 | **「会花钱」的确认统一成一个助手** `confirmUnattendedAiSpend(messageKey)`，它是全设置页唯一的 `window.confirm`。两个调用方：`onAutoEngineChange('autoTranslateEngineAiConfirm')`；规则编辑器里引擎新改成 'ai' 时（`'customRuleEngineAiConfirm'`）。`unattendedAiReachable()` 并上 `customRulesUseAi()`。导入不弹确认框 | 一条规则把某站点的自动翻译改成 AI，和把全局自动引擎改成 AI，花的是同一笔钱，确认也该是同一种形状。现有测试（`test/unit/auto-cost-gate.test.mjs:118`）只钉住一处 `window.confirm`；抽成助手后，测试改为钉「只有一个 `window.confirm(`，两个调用方」，以后第三个调用方也绕不开它。导入时，预览里的 AI 提示加上用户点「导入」这个动作，就是同意 |

## 1. 现状（file:line）

| 位置 | 现状 | 本轮 |
|---|---|---|
| `shared/site-rules.js:69/:84/:101/:108/:138` | `normalizeHost` / `hostMatches` / `splitPattern` / `patternMatches` / `validPattern` 覆盖 `host[/path-glob]` 模式的全部判断；`validPattern` 拒绝主机里带 `*` | B1：custom-rules 通过 `SiteRules` 的导出直接复用，不复制；还没导出的补进导出表 |
| `shared/site-rules.js:226-237` | `matchBuiltin()` | 不改 |
| `shared/site-rules.js:413-438`、`:536-557` | SW 单写者队列：`IN_SERVICE_WORKER`、`writeQueue` / `enqueue`、`MAX_ITEM_BYTES = 6 * 1024`、`itemBytes`、`WRITES`、`applyWrite`、`request`（`:550-557`，出错即抛） | B1：改用 `StorageWriter.create({errors: 'throw'})` |
| `shared/auto-stats.js:166-176`、`:222-247` | 同一套队列的第二份抄本；`request` 吞掉错误回 null | B1：改用 `StorageWriter.create({errors: 'swallow'})` |
| `background/background.js:127-144` | `onMessage` 里两段 if：`SITE_RULES_WRITE` → `SiteRules.applyWrite`，`AUTO_STATS_WRITE` → `AutoStats.applyWrite` | B1：改成一张分派表，新增 `CUSTOM_RULES_WRITE`、`CUSTOM_RULES_FOR_HOST` |
| `background/background.js:10-14`、`background/ai-translate.js:10`、`background/api-client.js:7` | 各 SW 模块各自 import site-rules / auto-stats | B1：三个文件都在这些 import 之前自行 import `shared/storage-writer.js`（SW 模块图深度优先求值，只靠入口 import 一次不够）；`background.js:11` 之后 import `shared/custom-rules.js` |
| `test/unit/site-rules.test.mjs` 约 `:786-803` | `LOAD_LISTS`（background.js、options.html、popup.html）、`LOAD_ORDER` | B1：`LOAD_ORDER` 加 site-rules → storage-writer、auto-stats → storage-writer、custom-rules → storage-writer、custom-rules → site-rules；`LOAD_LISTS` 加 `background/ai-translate.js`、`background/api-client.js` |
| `content/page/site-adapter.js:24-68` | `resolveSiteAdapter()` 以 `hostname\npathname` 为缓存键，返回内置规则的 `{atomic, exclude}` 或 null；`:28-43` 的 `usableSelector` 在使用时滤掉无效选择器 | B1：exclude 并入用户规则，缓存键加上 `ctx.customRules.version`；用户选择器同样过 `usableSelector` |
| `content/page/collect.js`（A2）`:55`、`:293`、`:321` | `closestAcross` 可跨 shadow 找祖先；块级 exclude；自家 UI 排除列表 | B1：新增 `ctx.ruleForbids`；B2：拾取器根节点加进 `:321` 的列表 |
| `content/page/collect.js`（A2）`:79-81`、`:506-508` | `scope` / `scopeCut` / `allowed`；`scopeCut && ctx.pageScopeStarts(...)` | B1：条件改成 `scope &&`（include 模式没有 cut）；include 模式下 `allowed` = 落在某个 root 里 |
| `content/page/collect.js`（A2）`:710-714` | 行内 notranslate 元素 → 占位符原样保留 | B1：行内 keepOriginal 走同一条路 |
| `content/page/notranslate.js`（A2）`:29/:44` | `ownTranslateDeclaration` / `createTranslateJudge` | B1：judge 接收 keepOriginal 选择器，命中的行内元素答 'no' |
| `content/page/scope.js`（A2）`:53-57` | `pageScopeMode()` 阶梯；`:56-57` 的注释写着「include（这个站点整页翻）命中即 'page'」 | B1：插入用户 include 一档，注释改正（include 是「只翻这些区域」，不是整页） |
| `content/page/scope.js`（A2）`:100-102`、`:119` | `resolvePageScope()` 的缓存键为 `href\nsetting\noverride`；`invalidatePageScope()` | B1：缓存键加 `ctx.customRules.version` |
| `content/page/scope.js`（A2）`:170` | `pageScopeStarts(dirty, scope)` 第一行是 `if (!scope \|\| !scope.skip) return [dirty];` | B1：include 分支放在这一行之前 |
| `content/content-float-ball.js`（A2）`:472-473`、`:560-562` | `showWholePage` 只在 `pageScopeMode() === 'main'` 时为真；菜单高度按项累加 | B1：条件改成 `!== 'page'`；B2：加「调整本站翻译区域」一项 |
| `content/content-translation-engine.js:86-91`、`:428-432` | `isBuiltinSelected(auto)` / `shouldUseBuiltin` / `effectiveEngine({auto})` 只看两个全局开关 | B1：先问 `ctx.customRules.engineOverride()`（§3.7） |
| `content/content-translation-engine.js:434-458`、`:577` | 预算闸注释说「能走到这一行的自动请求只有两种」；`ctx.requestTranslation` | B1：注释改成三种；`requestTranslation` 开头 `await ctx.customRules.whenReady()` |
| `content/frames/top.js`（A1）`:45/:54/:62` | `computeDirective` / `sameDirective` / `broadcastDirective`，指令形状为 `{translate, manualEpoch, visible, scopeOverride}` | B1：加 `engineOverride` |
| `content/frames/child.js`（A1）`:176-182` | `applyDirective` | B1：`ctx.customRules.inherit(engineOverride)`，null 也照传 |
| `content/content-bootstrap.js:120-133`、`:191-200` | `setupStorageListener` 在 `:131-133` 镜像设置键；`ctx.init` | B1：`customRule:` 键转给 `ctx.customRules.onStorageChange`，不进设置镜像；`ctx.init` 在启动调度器之前等 `whenReady()` |
| `content/content-messaging.js:24/:167` | `switch (message.type)`；`SETTINGS_UPDATED` | B2：加 `OPEN_RULE_PICKER`，只由顶层 frame 应答 |
| `options/options-auto.js:42-73` | `unattendedAiReachable()` `:42-46`；`syncAutoEngineState()` `:48-51`；`:53-64` 的注释自称是唯一的 `window.confirm`；`onAutoEngineChange` `:65-73` | B2：抽出 `confirmUnattendedAiSpend`，改注释，`unattendedAiReachable` 并上 `customRulesUseAi()` |
| `test/unit/auto-cost-gate.test.mjs:109-120` | `:118` 断言 `window.confirm(t('autoTranslateEngineAiConfirm'))`，`:120` 断言回退 | B2：改为断言两个调用点，且 `optionsSource()` 里恰好一个 `window.confirm(` |
| `options/options.html:183`、`:266-316`、`:836-880` | 自动翻译卡（引擎选择 `:208-211`）；「你表过态的网站」卡（`siteRules`）；脚本表 | B1：脚本表加 storage-writer、custom-rules；B2：新卡片放在 siteRules 卡之后 |
| `popup/popup.html:112/:143/:149`、`popup/popup.js:514-523` | 设置按钮；lang-tags、site-rules 脚本；`sendToActiveTab` | B1：site-rules 之前加 storage-writer；B2：加拾取器按钮 |
| `content/css/popup.css:95-98/:110/:117-119` | 重置层的 `:is()` 列表 | B2：加 `#ai-translator-rule-picker` |
| `manifest.json` `content_scripts[1]` `:81/:89/:90`、css 表 | lang-tags `:81`、site-rules `:89`、auto-stats `:90`；CSS 12 个 | B1：storage-writer 放在 site-rules 之前，custom-rules 放在 auto-stats 之后，`content/page/custom-rule.js` 放在 `site-adapter.js` 之前；B2：`content/picker/*`、`content/css/rule-picker.css`（放在 css 表末尾） |
| `content/page/insert.js:293`、`:558`（P0-C 所有） | `releaseTranslation(element)` 返回布尔值：去掉 `.ai-translator-translated`，恢复被藏起的原文；导出为 `ctx.releaseTranslation` | 只调用，不改 |
| `docs/privacy-policy.md:98-106` | 「三、存在你电脑上的东西」表，`:103` 是站点规则一行 | B2：在 `:103` 之后加一行 |

## 2. 数据与存储

### 2.1 sync 额度表（合计 = 100 KiB，即 `QUOTA_BYTES`）

| 占用方 | 额度 | 依据 |
|---|---|---|
| 设置（`background/settings.js` 的 `defaultSettings` ∪ `shared/default-settings.js` 的 `CONTENT_DEFAULTS`） | ≤ 12 KiB | 实测：合并去重后 43 个键，默认值合计 1004 B（约 1.0 KiB），最大的是 `apiEndpoint`（55 B）；余下的空间留给用户改长的值和以后新增的设置 |
| `siteRules` | ≤ 6 KiB | 单键，受 `ITEM_BUDGET` 约束 |
| `siteAskCount` | ≤ 6 KiB | 同上 |
| `customRule:*` | ≤ 24 KiB，≤ 50 条 | 本轮 |
| P1-C 词表 | ≤ 32 KiB | 预留 |
| P1-D 配置档 | ≤ 8 KiB | 预留 |
| 余量 | 12 KiB | |

另外几条 sync 硬限制：单项 8 KiB（`QUOTA_BYTES_PER_ITEM`，JSON 加键名）、最多 512 项、每分钟 120 次写、每小时 1800 次写；一次多键 `set` 算一次写。

### 2.2 规则结构 v1

```js
{
  id: 'k3f9x0qa',                  // 8 位 base36，CustomRules.newId()（crypto.getRandomValues）
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

- 未知字段写入时丢弃。
- `v` 大于 1 的条目读取时当作不认识，直接跳过，免得旧版本误读新版本写的规则。
- 一个有效字段都没有的规则拒写（`customRuleInvalid`）。
- 选择器语法只能在有 DOM 的地方检查：`validateRule(rule, {checkSelector})` 的 `checkSelector` 由设置页和拾取器传入。SW 只查形状和长度。内容脚本在使用时还会再过一遍 `usableSelector`，无效的直接丢掉，不抛错。

### 2.3 `shared/custom-rules.js`（`globalThis.CustomRules`，双模经典脚本）

| 导出 | 作用 |
|---|---|
| `KEY_PREFIX`、`LIMITS` | `'customRule:'`；`{ruleBytes: 6144, totalBytes: 24576, maxRules: 50, maxPatterns: 8, maxSelectors: 50, maxSelectorLength: 500, maxCss: 4096}` |
| `newId()` | 8 位 base36 |
| `validateRule(rule, {checkSelector})` | 返回规范化后的规则，或抛 `Error(<i18n 键>)` |
| `sanitizeCss(css)` | 返回清洗后的文本，或抛 `Error('customRuleCssUnsafe')`（§0.1-10） |
| `collect(items)` | 把 `get(null)` 的结果变成规则数组：前缀过滤、校验，坏条目跳过 |
| `forHost(rules, host)` / `pick(rules, host, path)` | 按主机过滤 / 求胜出规则（§0.1-5），没有则为 null |
| `applyChanges(rules, changes, host)` | 纯函数，把 `storage.onChanged` 的增量应用到规则集上（增、替、删，别的主机的规则忽略） |
| `usage(rules)` | `{bytes, count}`，供用量表和额度检查共用 |
| `mergeImport(existing, file)` | 返回 `{rules, added, replaced}`；格式不对或任一条无效就整体抛错 |
| `toExportFile(rules)` | 生成 §0.1-16 的对象 |
| `applyWrite` / `request` | 由 `StorageWriter.create({type: 'CUSTOM_RULES_WRITE', writes, errors: 'throw'})` 给出 |

加载位置：SW、内容脚本、设置页；popup 不加载。它在加载时捕获 `SiteRules` 与 `StorageWriter`，缺了就抛错（沿用 LangTags 的先例）。

### 2.4 写入：SW 单写者，`CUSTOM_RULES_WRITE`

| op | 参数 | 结果 |
|---|---|---|
| `put` | `{rule}` | 新增，或整条替换同 id 的规则；返回 `{id}` |
| `remove` | `{id}` | 删掉一条 |
| `import` | `{file}` | `mergeImport` 后一次多键 `set`；返回 `{added, replaced}` |
| `addSelector` | `{host, path, field, selector}` | 把选择器追加到这个 URL 的胜出规则的 `field` 里，已有则不重复；没有胜出规则就新建一条，`match: [normalizeHost(host)]`；返回 `{id}` |

每个 op 的步骤都一样：`get(null)` → 前缀过滤 → 算出结果 → 按结果检查额度（单条 6 KiB、合计 24 KiB、50 条）→ 写入。

错误以 i18n 键作为 `error` 返回：`customRuleInvalid`、`customRuleCssUnsafe`、`customRuleMatchInvalid`、`customRuleSelectorInvalid`、`customRuleTooLarge`、`customRulesBudgetFull`，其余一律 `customRuleSaveFailed`。

StorageWriter 的 'throw' 模式在没有 runtime 时返回一个被拒的 Promise。今天 site-rules 在这种情况下是同步抛 TypeError，所以实现时要逐个核对 `SiteRules` 写入的调用方，交付时列出来。

### 2.5 读取

- **SW** 处理 `CUSTOM_RULES_FOR_HOST`：用 `new URL(sender.url).hostname` 取主机 → `get(null)` → `collect` → `forHost` → 回 `{rules}`。这里回的是该主机的全部规则，路径交给内容脚本去挑。SW 在模块内存里记住 `collect` 的结果，收到 `customRule:` 键的 `storage.onChanged` 就作废。SW 随时可能被回收，这份记忆只是缓存。
- **内容脚本**：每个文档只发一次请求。请求在路上时收到的增量先按顺序缓冲，回话到了再依次应用。此后的增量经 `applyChanges` 处理，去抖约 150 ms，然后 `version++` 并通知订阅者。
- **设置页**：`get(null)` → `collect`，并挂自己的 `onChanged` 监听。

## 3. 页面接线（B1）

### 3.1 `ctx.customRules`（`content/page/custom-rule.js`）

| 成员 | 作用 |
|---|---|
| `init()` | 发出 `CUSTOM_RULES_FOR_HOST`。dormant frame 根本不建 ctx，自然什么也不发 |
| `whenReady()` | 首个回话到达，或超过 1500 ms，Promise 就 resolve。超时按「无规则、全局引擎」处理，回话晚到仍照常生效 |
| `current()` | 本 URL 的胜出规则，形状 `{id, include, exclude, keepOriginal, css, engine}`，或 null。以 `location.href` + `version` 记忆，SPA 换路径后自然重算 |
| `version` | 规则集每变一次加 1 |
| `onStorageChange(changes)` | 接收 bootstrap 转来的 `customRule:` 增量 |
| `engineOverride()` | 顶层返回 `current().engine`；子 frame 返回从顶层指令继承来的值 |
| `inherit(engine)` | 子 frame 专用；null 也要照传，表示「顶层没有覆盖」 |
| `onChange(fn)` | 订阅规则变化 |

有三处要等 `whenReady()`：`ctx.init` 启动自动翻译调度器之前；整页翻译入口；`ctx.requestTranslation` 开头。SW 冷启动时，这最多让首轮推迟 1.5 s。

### 3.2 与内置适配器合并

`resolveSiteAdapter()` 返回 `{atomic: 内置.atomic, exclude: 内置.exclude ∪ 用户.exclude}`，缓存键加上 `version`。include 由 scope.js 读 `current()`；keepOriginal 由 collect.js / notranslate.js 读 `current()`。「用户优先」只体现在两处：exclude 可以加，但撤不掉内置的；include、keepOriginal 只有用户规则提供。

### 3.3 exclude / keepOriginal

| | 命中一个块 | 命中块里的行内元素 |
|---|---|---|
| exclude（内置 ∪ 用户） | 整块跳过（`closestAcross`，与内置 exclude 走同一条路，A2 collect.js:293） | 它的文字从原文里拿掉：不送去翻译，译文里也不出现 |
| keepOriginal | 整块跳过（`ctx.ruleForbids`，在 translate judge 之前判） | 按 `translate="no"` 处理：送出占位符，译文里原样出现（A2 collect.js:710-714） |

`ctx.ruleForbids(el, scope)` 定义在 collect.js：`closestAcross(el, exclude ∪ keepOriginal)` 为真，或 `ctx.outsidePageScope(el, scope)` 为真。

### 3.4 范围阶梯（改 A2 的 `pageScopeMode` / `resolvePageScope`）

1. `state.pageScopeOverride === 'page'`（来自「翻译整个页面」入口）→ 'page'
2. `current().include` 在 `queryAllDeep` 下至少命中一个已渲染元素（`getClientRects().length > 0`）→ 'include'
3. 设置 `pageTranslateScope === 'page'`，或 `matchBuiltin` 命中 → 'page'
4. 否则 → 'main'

- **include 的结果形状**是 `{mode: 'include', roots, skip: null, share: null}`。`roots` 取命中元素里最外层的那些：被别的命中元素包含的去掉。第 2 档零命中时不缓存，下次调用再判。
- **`pageScopeStarts(dirty, scope)` 的 include 分支**：`dirty` 在某个 root 里 → `[dirty]`；`dirty` 包含若干 root → 返回这些 root；两者不相交 → `[]`。不做 'main' 模式那套孤儿 h1 处理。
- **`ctx.outsidePageScope(el, scope)`** 定义在 scope.js，只在 include 模式下可能为真：`el` 不在任何 root 里时为真。
- **`pageScopeMode()` 多了一个取值 'include'**。所有写 `=== 'main'` / `=== 'page'` 的调用点要逐个核对，交付时列出来。悬浮球的 `showWholePage` 改成 `!== 'page'`，所以 include 模式下也提供「翻译整个页面」。
- **缓存**：`resolvePageScope()` 的缓存键加上 `ctx.customRules.version`，这是规则变化唯一需要的作废手段。范围从别的模式切到 include 时，同样走 §3.6 第 4 步的清扫；无论是规则变更引起的，还是 include 晚到命中引起的。

### 3.5 CSS

- `custom-rule.js` 只持有一个 `CSSStyleSheet`，用 `replaceSync(清洗后的文本)` 填充，挂载写法为 `document.adoptedStyleSheets = [...当前列表去掉我们那张, 我们那张]`，页面自己的 sheet 保留。
- 两个时机重新挂载：每轮翻译开始时（按当前 URL 重算 `current()`）；每次规则变化时。这是因为有些页面会整体重写 `adoptedStyleSheets`，把我们那张冲掉。
- 构造或挂载抛错时，在接住的地方打一条日志（操作名 + 原始错误），本页不应用这段自定义 CSS；规则的其余字段照常生效。没有 `<style>` 退路（D-297）。
- 内容侧清洗不过，就不应用这段 CSS，只打一条 `console.warn`；规则的其余字段照常生效。
- 不注入 shadow root。

### 3.6 规则变化后的流水线（≤ 1 s）

`onChange` 触发后按顺序做六步：

1. `version++`。
2. site-adapter 缓存按新 `version` 换键。
3. CSS 重新挂载。
4. **清扫**：`queryAllDeep('.ai-translator-translated')`，筛出 `ctx.ruleForbids(el, scope)` 为真的元素，逐个 `ctx.releaseTranslation(el)`（P0-C 的导出，只调用）。
5. 页面处于已翻译状态时，跑一轮增量收块，把新放开的块（比如删掉了一条 exclude）翻上。
6. 顶层 frame 按新的 `engineOverride` 重算指令，变了就广播。

引擎变化只影响之后的请求，已有译文不重译。

### 3.7 引擎

```js
function isBuiltinSelected(auto) {
  const pinned = ctx.customRules && ctx.customRules.engineOverride();
  if (pinned) return pinned !== 'ai';
  return (auto ? settings.autoTranslateEngine : settings.translationEngine) !== 'ai';
}
```

- `shouldUseBuiltin`、`effectiveEngine({auto})` 都经过这一个函数，所以 popup 和悬浮球显示的就是本站实际用的引擎。
- `refuseAutoAiSpend()` 的代码不动。`:434-458` 的注释从「两种」改成「三种」，第三种是：按站点规则固定为 AI 的自动 / 无人值守请求。
- 规则选了 'ai' 但没配 Key，走现有的没配 Key 路径（P0-A 所有，不碰）。

### 3.8 frames（A1 文件）

- 顶层 `computeDirective()` 加上 `engineOverride: ctx.customRules.engineOverride() || null`，`sameDirective()` 把它也纳入比较。§3.6 第 6 步就走这条路广播。
- 子 frame 的 `applyDirective()` 调 `ctx.customRules.inherit(directive.engineOverride ?? null)`，null 照传。这与 `:181` 的 `scopeOverride` 只在真值时才应用不同；后者由 A 整合时修，见 §12。
- 子 frame 的 include / exclude / keepOriginal / CSS 来自它自己 URL 的 `CUSTOM_RULES_FOR_HOST`。

## 4. 设置页（B2，`options/options-custom-rules.js`）

新卡片「站点翻译规则」放在「你表过态的网站」卡（`siteRulesTitle`）之后，两者标题不冲突。

- **列表**：每条规则一行，显示第一条匹配模式（多于一条时加「+N」），以及字段小标签（范围 / 排除 / 保留原文 / CSS / 引擎）。按钮是「编辑」「删除」；删除分两步，先点「删除」再点「确认删除」。
- **编辑器**：在原位展开，列表顶上有「新建规则」按钮。
  - 字段：匹配网址、只翻译这些区域、不翻译这些区域、保留原文，都是每行一条；自定义 CSS 用等宽 textarea，提示里写明译文的类名 `.ai-translator-inline-block`、被禁止的写法，以及反斜杠会被拒；翻译引擎是下拉框，选项为「跟随全局设置」（`customRuleEngineFollow`）/ 复用 `autoTranslateEngineBuiltin` / 复用 `autoTranslateEngineAi`。
  - 按钮「保存」「取消」。错误显示在对应字段下方，选择器逐条用 `checkSelector` 检查。
- **引擎确认**：引擎从非 'ai' 改成 'ai' 时，调 `confirmUnattendedAiSpend('customRuleEngineAiConfirm')`。用户取消，下拉框回到原值，也不保存。
- **用量表**：「已用 x KiB / 24 KiB · n / 50 条」，数字来自 `CustomRules.usage`。
- **导出**：Blob 加 `<a download="blab-site-rules-YYYYMMDD.json">`。
- **导入**：
  1. 用户选文件，前端解析后给出预览：「将新增 N 条、替换 M 条」。
  2. 若有规则带 `engine: 'ai'`，预览里多一行 AI 提示：「其中 K 条会让这些网站的自动翻译使用你的 AI 接口，并计入每日 AI 额度」。
  3. 按钮「导入」「取消」。
  4. 格式不对报 `customRulesImportInvalid`，超额报 `customRulesBudgetFull`；两种情况存储都不变。
- **联动**：设置页挂自己的 `storage.onChanged` 监听（sync 区的 `customRule:` 键），变化后重绘。全局函数 `customRulesUseAi()` 判断是否有规则 `engine === 'ai'`。每次重绘后调 `syncAutoEngineState()`，让每日额度输入框的启用状态跟上。
- **`options-auto.js` 的改动**：抽出 `confirmUnattendedAiSpend(messageKey)`，`onAutoEngineChange` 改为调用它；`:53-64` 的注释同步改；`unattendedAiReachable()` 并上 `typeof customRulesUseAi === 'function' && customRulesUseAi()`。

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
- **保存**：发 `CUSTOM_RULES_WRITE`，op 为 `addSelector`，参数 `{host: location.hostname, path: location.pathname, field, selector}`。成功后提示 `pickerSaved`（「已保存，可在 设置 → 站点翻译规则 里修改」），关闭拾取器；§3.6 的流水线会让页面在 1 s 内变化。失败时提示错误键对应的文案，拾取器保持打开。
- **Esc 或「取消」**：移除全部节点和监听器，不留痕迹（e2e 断言残留为零）。
- **几何**：视口 1280×800 与 375×812 下，工具条都完整落在视口内，描框与目标 rect 的误差 ≤ 1 px。
- **入口**：
  - 悬浮球菜单项 `edit-site-rule`，文案 `pickSiteRegion`（「调整本站翻译区域」/ "Adjust what gets translated here"）。菜单高度：若 #105 已合入，就遵循它「菜单自己量高度」的做法；否则 `+ 40`，并作为偏差申报。
  - popup 按钮，文案同上，走 `sendToActiveTab({type: 'OPEN_RULE_PICKER'})`，发完 `window.close()`。
- **不做撤销**，删规则去设置页。

## 6. 旅程规格（e2e，一条旅程至少一个 spec）

B1 交付时，J-2、J-3、J-4 的后半、J-9 先以「夹具预置规则」的形式跑：直接往 `storage.sync` 写 `customRule:` 键，spec 标题带 `[fixture]`。B2 把 J-1 到 J-9 全部改成走真实入口（拾取器、设置页）；夹具版要么删掉，要么保留为隔离某个子步骤用，并标注清楚。夹具主机一律用 `context.route` 路由的假主机；AI 走 `test/e2e/mock-openai-server.js`。

| # | 旅程 | 步骤 → 用户可观察结果 |
|---|---|---|
| J-1 | 拾取器排除（用户点名的旅程） | 夹具页含正文和评论区 `.comments`。点悬浮球「翻译」→ 正文和评论区都出现译文 → 打开悬浮菜单，「调整本站翻译区域」项的几何落在菜单盒内，菜单在视口内 → 点它 → 悬停评论区，描框与评论区 rect 一致 → 点击 → 工具条显示选择器和「匹配 1 处」→ 点「不翻译这里」→ 1 s 内评论区译文消失、正文译文仍在，并出现保存提示 → `storage.sync` 里恰好一个 `customRule:` 键，其 `exclude` 含该选择器 → 重载页面再翻译 → 评论区译文节点为 0，正文有译文 |
| J-2 | 保留原文 | 在设置页新建规则：匹配夹具主机，保留原文填 `.brand`（行内）和 `.code-name`（块）→ 保存 → 打开夹具翻译 → `.code-name` 块没有译文；含 `<span class="brand">BrandX</span>` 的段落有译文，且译文里原样出现 BrandX |
| J-3 | 只翻译这里 + 整页入口 | 夹具含 nav、main、aside，设置为 `pageTranslateScope: 'page'` → 用拾取器选 aside 里的 `.faq`，点「只翻译这里」→ 翻译 → 只有 `.faq` 有译文，nav 和 main 都没有 → 悬浮菜单里出现「翻译整个页面」，且几何在菜单盒内 → 点它 → 全页都有译文 |
| J-4 | 自定义 CSS 与安全 | 在设置页给夹具主机的规则写 CSS `.ai-translator-inline-block { color: rgb(1, 2, 3) }` → 保存 → 另一个已打开并已翻译的夹具标签页里，1 s 内译文的计算色变为 `rgb(1, 2, 3)`，没有重载 → 在编辑器里追加 `body { background: url(http://127.0.0.1:<port>/leak) }` → 保存被拒，字段下出现 `customRuleCssUnsafe` 的文案，存储不变 → 从 SW 上下文直接往 `storage.sync` 写一条带这段 CSS 的规则（模拟绕过设置页的写入）→ 页面不应用它，mock 服务器收到的 `/leak` 请求为 0 |
| J-5 | 导出 / 导入 | 设置页已有规则 A → 点导出，下载的 JSON 里 `format`、`version`、`rules` 都正确 → 准备一个文件：A 改一个字段，再加一条 `engine: 'ai'` 的新规则 B → 导入 → 预览显示「新增 1 条、替换 1 条」，并有 AI 提示 → 点「导入」→ 列表两条，A 为新内容 → 再导入一个坏 JSON → 报错，存储逐字节不变 |
| J-6 | 按站点引擎 | 全局的手动和自动引擎都是「内置」，不允许回退 → 设置页每日额度输入框为灰 → 新建规则，引擎选「我的 AI」→ 弹出确认框，文案为 `customRuleEngineAiConfirm` → 点取消，下拉框回到原值，规则没有保存 → 再选一次并接受 → 保存 → 额度输入框变为可用 → 站点设为「总是」→ 打开夹具 → 自动翻译的请求打到 mock AI 服务器，页面出现译文，今天的 AI 用量 > 0（从设置页的用量行或存储里读回） |
| J-7 | 用量表 | 预置 49 条规则，体积接近 24 KiB → 设置页用量表显示对应的 KiB 数和「49 / 50」→ 再新建一条会超额的规则 → 被拒，出现 `customRulesBudgetFull` 的文案，存储不变 |
| J-8 | 跨标签即时生效 | 夹具页已翻译 → 在另一个标签的设置页里新增一条排除规则 → 夹具页 1 s 内该区域译文消失，没有重载 → 从 SW 上下文直接删掉这条规则（模拟另一台设备同步下来的变化）→ 1 s 内夹具页该区域重新出现译文，靠的是增量那一轮 |
| J-9 | iframe | 顶层夹具（主机 T）嵌一个 iframe（主机 F）。规则 A 匹配 F，exclude `.side-note`；规则 B 匹配 T，引擎 'ai'；全局引擎为内置 → 翻译 → iframe 里 `.side-note` 没有译文，其他段落有译文；iframe 里的段落文本出现在 mock AI 服务器的请求里 |

单测清单：

| 批 | 覆盖 |
|---|---|
| B1 | storage-writer：串行、'throw' / 'swallow'、`ITEM_BUDGET`、无 runtime 时的行为；另有一条守卫，`shared/` 与 `background/` 里不许出现第二个 `writeQueue` / `enqueue` |
| B1 | custom-rules：`validateRule`、`sanitizeCss` 表（每个禁用写法、`u/**/rl(`、`URL(` 大写、反斜杠转义、4096 上限）、`pick` 的三级平局、`applyChanges`、`mergeImport`（全有或全无、按合并后结果算额度、计数）、`addSelector`（追加去重、新建时 `normalizeHost`）、额度三条上限、`newId` 格式 |
| B1 | 加载顺序（`site-rules.test.mjs` 的 `LOAD_ORDER` / `LOAD_LISTS`）；Node harness 先加载 storage-writer |
| B1 | 引擎：`isBuiltinSelected` 在有覆盖、无覆盖、覆盖为 null 时的取值（engine harness） |
| B1 | frames：`computeDirective` / `sameDirective` 含 `engineOverride`；子 frame `inherit(null)` |
| B1 | scope：阶梯四档、include 零命中不缓存、`pageScopeStarts` include 分支三种情况、`outsidePageScope` |
| B1 | collect：行内 exclude 被拿掉、行内 keepOriginal 用占位符、块级 keepOriginal 压过 `translate="yes"` |
| B2 | picker selector：优先级、`isVolatileClass` 表、唯一性、5 层上限 |
| B2 | `auto-cost-gate`：确认助手的两个调用点，且只有一个 `window.confirm(` |
| B2 | `host-css-containment`：新根节点在 `:is()` 列表里 |

### 6.1 承诺清单 → 断言

| 文案承诺 | 断言 |
|---|---|
| 「保存后立即生效」（拾取器提示、设置页说明） | J-1 / J-4 / J-8：1 s 内生效、不重载 |
| 「CSS 不能加载外部资源」（CSS 提示） | J-4：保存被拒；绕过设置页写进去的也不应用，mock 服务器零请求；单测清洗表 |
| 「自动翻译也会用你的 AI 接口，并计入每日额度」（确认框、导入预览） | J-6：mock 服务器收到请求，AI 用量增加 |
| 「导入会替换同 id 的规则」（导入预览） | J-5 |
| 「规则跟着账号同步」（卡片说明） | J-1：键在 `storage.sync` 区；J-8：sync 区的外来变化 1 s 内生效 |
| 用量表「x KiB / 24 KiB · n / 50 条」 | J-7 |
| 「匹配 {n} 处」 | J-1（n = 1）、J-3 |
| 隐私政策新行「自定义站点翻译规则 … `chrome.storage.sync`」 | J-1：键在 sync 区 |

## 7. 已知限制（写进 PR 与 backlog）

- 同一 URL 命中多条规则时不叠加，只有最具体的一条生效。
- include 在页面上零命中时回落到正文 / 整页，不会变成「什么都不翻」。
- 自定义 CSS 不进 shadow DOM。
- 拾取器够不着 iframe 里的元素（只在顶层工作），iframe 的规则只能在设置页写；closed shadow root 里的元素只能选到它的宿主。
- popup 打开得太早时（规则还没从后台回来，最多 1.5 s）显示的是全局引擎。
- 页面整体重写 `document.adoptedStyleSheets` 后，自定义 CSS 要等下一轮翻译或下一次规则变化才会回来。
- 内置适配器的 exclude 用户撤不掉。
- 改引擎不会重译已有译文。
- 行内 exclude 的文字在「仅译文」模式下看不见：它不在送出的原文里，所以也不在译文里。
- CSS 里的反斜杠一律拒绝，`content: "\201C"` 这类合法写法也在其列（提示里说明，请改用字面字符）。

## 8. i18n

全部新键都进 `i18n/lang/*`（10 种语言）。B1 不新增用户可见文案。

| 键 | 用途 |
|---|---|
| `customRulesTitle` / `customRulesDesc` / `customRulesAdd` / `customRulesEmpty` / `customRulesUsage` | 卡片标题、说明、新建、空态、用量表 |
| `customRulesExport` / `customRulesImport` / `customRulesImportPreview` / `customRulesImportAiNote` / `customRulesImportConfirm` / `customRulesImportInvalid` | 导出与导入 |
| `customRuleMatch` / `customRuleInclude` / `customRuleExclude` / `customRuleKeepOriginal` / `customRuleCss` / `customRuleCssHint` / `customRuleEngine` / `customRuleEngineFollow` | 编辑器字段。引擎的另两个选项复用 `autoTranslateEngineBuiltin` / `autoTranslateEngineAi` |
| `customRuleChipScope` / `customRuleChipExclude` / `customRuleChipKeep` / `customRuleChipCss` / `customRuleChipEngine` | 列表里的字段小标签 |
| `customRuleEdit` / `customRuleDelete` / `customRuleDeleteConfirm` | 行内按钮；「保存」「取消」若已有通用键就复用，交付时列出 |
| `customRuleInvalid` / `customRuleCssUnsafe` / `customRuleMatchInvalid` / `customRuleSelectorInvalid` / `customRuleTooLarge` / `customRulesBudgetFull` / `customRuleSaveFailed` | 错误 |
| `customRuleEngineAiConfirm` | 确认框 |
| `pickSiteRegion` | 悬浮菜单项和 popup 按钮 |
| `pickerHint` / `pickerMatches` / `pickerParent` / `pickerExclude` / `pickerKeepOriginal` / `pickerInclude` / `pickerCancel` / `pickerSaved` | 拾取器 |

## 9. 文件归属与切批

| 文件 | B1 | B2 |
|---|---|---|
| 新增 `shared/storage-writer.js`、`shared/custom-rules.js`、`content/page/custom-rule.js` | ✔ | — |
| `shared/site-rules.js`、`shared/auto-stats.js` | 改用 StorageWriter；补导出 | — |
| `background/background.js`、`background/ai-translate.js`、`background/api-client.js` | import 顺序、分派表、两个新消息 | — |
| `manifest.json` | 三个新文件入表 | `content/picker/*`、`content/css/rule-picker.css` 入表 |
| `content/page/site-adapter.js`、`collect.js`、`notranslate.js`、`scope.js` | ✔ | `collect.js:321` 自家 UI 列表加拾取器根 |
| `content/content-translation-engine.js` | `isBuiltinSelected`、`whenReady`、预算注释 | — |
| `content/frames/top.js`、`content/frames/child.js`（A1） | `engineOverride` | — |
| `content/content-bootstrap.js` | 转发增量；init 等 `whenReady` | — |
| `content/content-float-ball.js` | `showWholePage` 的条件 | 菜单项 |
| `content/content-messaging.js` | — | `OPEN_RULE_PICKER` |
| `options/options.html`、`popup/popup.html` | 脚本表（options 加两个 shared 文件，popup 只加 storage-writer） | options 新卡片与脚本；popup 按钮 |
| 新增 `content/picker/{selector,toolbar,picker}.js`、`content/css/rule-picker.css`、`options/options-custom-rules.js` | — | ✔ |
| `options/options-auto.js`、`test/unit/auto-cost-gate.test.mjs` | — | 确认助手 |
| `popup/popup.js`、`content/css/popup.css` | — | 按钮；`:is()` 列表 |
| `i18n/lang/*`（10 种） | — | ✔ |
| 文档：`CHANGELOG.md`（顶部 `## Unreleased`）、`README.md`、商店文案、`docs/privacy-policy.md`、`CLAUDE.md` | — | ✔ CLAUDE.md 要做三件事：新增「User Site Rules」一节（解析器、键布局、StorageWriter）；「three unattended AI paths」改成 four；样式表数量按 A 整合后的实数加 1 |
| 加载清单守卫 | 按新增文件同步 `test/unit` 里所有 load-list 守卫，以及 e2e 的 `PAGE_TRANSLATION_MODULES` / `contentHarnessScripts` | 同左 |

不碰：`content/page/insert.js`（P0-C，只调用 `ctx.releaseTranslation`）、`content/content-selection.js` / `content/content-popup.js`（P0-D）、`background/commands.js`（P0-C）、目标语言、语言列表与 RTL（P0）、`pdf/`（P0）、`shared/api-compat.js` 与后台 Key 检查（P0-A）。

## 10. 门禁

```bash
npm run test:unit > <log> 2>&1; echo "GATE unit exit=$?"
npm run test:e2e > <log> 2>&1; echo "GATE e2e exit=$?"
```

两门都是 0 才算绿。不接 `| tail`（退出码会变成 tail 的）。

## 11. Backlog（本轮登记，不做）

- 拾取器撤销（在保存提示里放「撤销」）。
- 多条规则叠加。
- 在 iframe 里拾取（同源 frame）。
- 自定义 CSS 注入 shadow DOM。
- 按规则选模型 / 配置档（等 P1-D）。
- 规则市场 / 订阅。
- P1-B·style：按站点译文样式（等 #105）。
- 改引擎后重译已有译文。
- 允许撤销内置 exclude。
- closed shadow root 内拾取（`chrome.dom.openOrClosedShadowRoot` 加 `elementsFromPoint`）。

## 12. 与 P1-A 的接缝

- **B 负责的 A2 文件改动**：`scope.js:56-57` 的注释、`collect.js:506` 的条件。B 在 A 整合之后才开工，所以不和 A 抢同一份文件。
- **A 整合时处理，不归 B**：
  - `child.js:181` 的 `scopeOverride` 只在真值时应用，改成照传 null；
  - 收掉 `child.js:143` 的回落分支；
  - B-P0C-4：`#ai-translator-source-peek` 加进 collect 排除；
  - D-294 #1（`:host-context`）和 #4（Alt+W 归 P0-C 的 `commands.js`）；
  - 悬浮球 menuHeight 与 #105 对齐。
- **B 依赖 A 的名字**：`ctx.collectPageBlocks`、`ctx.invalidatePageScope`、`state.pageScopeOverride`、`ctx.frames.onVisibilityChanged`、`closestAcross`、`queryAllDeep`、`installStyle` / `hasStyle`、`computeDirective` / `sameDirective` / `applyDirective`。A 整合时若改了其中任何一个，B 的任务书跟着改。
