# P0-C 显示层：译文样式 + 双语/仅译文切换 + 仅译文下看原文 — 设计

基线：`feat/p0-a` 头 e8720a4（叠在 P0-A 上，#104 合入后 `git rebase --onto origin/main e8720a4 feat/p0-c`）。
主控：P0 回合主控（Opus 5.5）。实现：dev-opus-high。

## 0. 结论

- 六种译文样式：`default`（现状）、`underline`、`dashed`、`highlight`、`quote`、`blur`（悬停/点按才看清，即「学习模式」）。
  新同步键 `translationStyle`，缺省 `default`，老用户观感不变。
- 样式**纯 CSS**：`<html data-ai-translator-style="…">` 一个属性决定，规则在 `content/css/translation.css`。
  切换只改这个属性，不碰译文节点、不重译。除 `quote` 外，任何样式都不改变任何盒子的几何。
  `quote` 只在译文自己的起始侧加一条边线和一段内边距，原文一个字都不动（§2.2）。
- 双语 / 仅译文切换有四个入口，全部写同一个键 `showTranslationOnly`，页面由 bootstrap 的 storage 监听统一应用：
  设置页（已有开关）、popup 新「显示」行、悬浮球菜单新行、新快捷键 `toggle-translation-only`（建议 Alt+T）。
- 仅译文下看原文：悬停译文约 350 ms（鼠标）或点按译文（触屏/笔），弹出小卡 `#ai-translator-source-peek` 显示原文。
  条件不是「仅译文开着」，而是「这条译文的原文此刻藏着」——fit guard 因拥挤藏起原文的块同样能看。
- `content/page/insert.js` **不改**。P1 在 insert.js 上的工作（shadow DOM 插入、术语还原）不必等 P0-C。
- 顺带修一个同类缺陷：设置页整表回写会把别处（popup、悬浮球、快捷键）刚写的值用陈旧表单值盖回去。
  新增 `options/options-sync-mirror.js` 把外部写入镜像回表单（§5.4）。

## 1. 现状（file:line，基线 e8720a4）

| 位置 | 现状 |
| --- | --- |
| `content/page/insert.js:398-408` | 译文复制原文计算样式 + `opacity: 0.85`，唯一的外观 |
| `content/page/insert.js:512-515` | 原文文字前有图标时，译文带内联 `padding-left: <偏移> !important`（内联 important 压过任何样式表） |
| `content/page/insert.js:472-476` | 注释：页面会用 `margin-left/right: auto` 让每块居中，译文不许动水平外边距 |
| `content/css/translation.css:7-17` | `.ai-translator-inline` 死规则（全仓无节点用这个类）；`light-theme.css:37` 同名覆盖也是死的 |
| `content/css/translation.css:25-37` `.ai-translator-inline-block` | `display:block; margin-top/bottom; padding:0; border:none; background:none`，全部 `!important` |
| `content/css/translation.css:141-145` `a.ai-translator-inline-block` | `pointer-events:none !important`（锚点译文收不到指针） |
| `content/css/translation.css:179-184` `.ai-translator-inline-right` | 水平导航里的译文：`display:inline; font-size:.85em; opacity:.7; margin-left:4px` |
| `content/page/visibility.js:21` | `PAGE_TRANSLATION_SELECTOR` = 整页译文（排除划词、悬停） |
| `content/page/visibility.js:94-104` | `shouldHideSource` / `isTranslationOnlyActive` |
| `content/page/visibility.js:176-191` | `applyTranslationOnlyMode()`：全量释放再逐条重藏，幂等 |
| `content/page/visibility.js:202-213` | `releaseSourceForTranslation` 内联了「译文 → 它藏起来的原文」查找 |
| `content/content-bootstrap.js:171-174` | `changes.showTranslationOnly` → `ctx.applyTranslationOnlyMode()` |
| `content/content-float-ball.js:473-560` | 菜单 HTML；`menuHeight = 180 + …` 估高在 :550；`handleMenuAction` 在 :615 |
| `content/content-selection.js:76-86` | 所有浮层的 Esc 统一在这里收 |
| `background/background.js:295-304` | `onCommand` 只认 `toggle-translate-page` |
| `manifest.json:43-50` | `commands` 只有 `toggle-translate-page`（Alt+A） |
| `popup/popup.html:53-58` | `#togglePagePause` 行；其后是漫画行 |
| `popup/popup.js:535-545` | `refreshShortcutHint()` 只填一个 kbd |
| `options/options.html:441-447` | `showTranslationOnly` 开关 |
| `options/options.js:343` | `collectSettings()` 每次写**整张表**（:366 含 `showTranslationOnly`） |
| `options/options.js:577` | `IMMEDIATE_SAVE_FIELDS`（:588 含 `showTranslationOnly`）；`DEBOUNCED_SAVE_FIELDS` 在 :601 |
| `options/options.js:680-683` | `storage.onChanged` 只重画站点规则表和统计，不回填表单 → 陈旧回写缺陷 |

## 2. 样式

### 2.1 集合与唯一出处

新共享模块 `shared/translation-display.js`（IIFE，挂 `globalThis.TranslationDisplay`）：

```js
STYLES = ['default', 'underline', 'dashed', 'highlight', 'quote', 'blur']
DEFAULT_STYLE = 'default'
normalizeStyle(value)   // 不在 STYLES 里的一律回 DEFAULT_STYLE
styleLabelKey(style)    // → 'translationStyleDefault' / 'translationStyleUnderline' …
```

content（manifest，放在 shared 组里 `shared/default-settings.js` 之后）、popup、options 三处都装它。
三处的下拉框都由 `STYLES` 生成，不手写 `<option>`。
单测守：CSS 里每个 `data-ai-translator-style="X"` 的 X 都在 `STYLES`，`STYLES` 里除 `default` 外每个都在 CSS 里有规则。

### 2.2 不重排规则（硬约束）

原文永远不动。除 `quote` 外，切换样式不移动任何文字，也不移动后面的页面内容。

- 五种样式只许用画在盒外、不占位的属性：`text-decoration-*`、`text-underline-offset`、`outline*`、`box-shadow`、`background-color`、`border-radius`、`filter`、`transition`、`cursor`。
- `quote` 额外只许两样：`border-inline-start*` 和 `padding-inline-start`。
  它在译文**自己**的起始侧占 3px + 0.6em，译文自己的字可能因此换行，原文不动（RTL 自动翻到右侧）。
- **任何样式都不许碰 margin。** 页面会用 `margin-left/right: auto` 让每块居中（insert.js:472-476），
  盖掉它，整块译文就会跳到容器左侧。
  这正是「悬挂边线」方案（负 margin + padding + border 相加为零）被否的原因。
- 禁止：`font*`、`line-height`、`letter-spacing`、`word-spacing`、`display`、`position`、`width/height`、`margin*`，以及块方向的 padding/border。

单测按属性白名单守。e2e 对五种零几何样式量两样：译文的文字矩形（`Range.getClientRects()`）和下一个兄弟元素的矩形，都要与 `default` 相差 ≤ 0.5px。
对 `quote` 量原文矩形不变，并且译文首个文字矩形的起始边恰好内移「边线宽 + 内边距」。
例外：原文前有图标的块，译文带内联 `padding-left !important`（insert.js:512-515），它压过样式表，此时只内移边线宽 3px。

### 2.3 选择器与特异性

基础规则 `.ai-translator-inline-block {… !important}` 是 (0,1,0)。样式规则写成：

```css
html[data-ai-translator-style="underline"] .ai-translator-inline-block:not(.ai-translator-selection-translation):not(.ai-translator-hover-translation) { … !important }
```

这是 (0,4,1)，能盖过基础规则的 `background:none` / `border:none` / `padding:0` 以及 `a.ai-translator-inline-block {text-decoration:none}`。
译文节点属于「页面翻译节点」，按 CLAUDE.md 豁免宿主 CSS 隔离的四档带，照旧用 `!important`。
划词、悬停译文用同一个类但被 `:not()` 排除，不受样式影响。

### 2.4 各样式声明

强调色要在白底和近黑底上都有 ≥ 3:1 的非文字对比度。
译文整体带 `opacity: .85`（insert.js:407），装饰色也按 0.85 与底色合成，所以按合成后的有效色选色：`#4f6ef7`，不透明。

- 在白底上：有效色 (105,132,248)，对比 3.36:1。
- 在 #111 上：有效色 (70,96,213)，对比 3.50:1。
- 对照：`#5b7cfa` 合成后在白底只有 2.96:1，被否。

导航里的 `.ai-translator-inline-right` 是 `opacity: .7`，同一个蓝在两种底上都到不了 3:1。
单一强调色做不到，这一类不做对比度断言，在 §7.2 J-C7 如实写明。

| 样式 | 声明（全部 `!important`） |
| --- | --- |
| `underline` | `text-decoration: underline 2px #4f6ef7; text-underline-offset: 3px` |
| `dashed` | `outline: 1px dashed #4f6ef7; outline-offset: 1px; border-radius: 3px`（外扩合计 2px，约等于配对间距 0.15em，不碰原文字形） |
| `highlight` | `background-color: rgba(79,110,247,.16)`，外加只向左右延伸的 `box-shadow: -4px 0 0 <同色>, 4px 0 0 <同色>`（不往上下压到原文），`border-radius: 2px` |
| `quote` | `border-inline-start: 3px solid #4f6ef7; padding-inline-start: .6em` |
| `blur` | `filter: blur(5px); transition: filter .15s`；`:hover`、`:focus-within`、`.ai-translator-revealed` 时 `filter: none`。`prefers-reduced-motion` 下不过渡 |

`blur` 的两条限定：

1. **仅译文时不模糊。** 原文藏着、译文又糊着，这一块就什么都读不到。
   选择器带 `html:not([data-ai-translator-only])`。这个属性由 `applyTranslationOnlyMode()` 维护（§3.2）。
2. **锚点译文（`a.ai-translator-inline-block`）不模糊。** 它收不到指针，悬停永远揭不开。

点按揭开：`display.js` 在 document 上挂一个冒泡阶段的 click。点中的整页译文如果没有交互祖先（`a[href]`、`button`、`label`、`summary`、`[role=button]`），就切换 `.ai-translator-revealed`。
不 `preventDefault`，链接照常跳转。
找译文用 `event.composedPath()`，不用 `event.target`：P1-A2 之后译文可能在 shadow root 里，document 上收到的 target 会被重定向成宿主（§9.1）。

### 2.5 死代码

删掉 `translation.css:7-17` 的 `.ai-translator-inline` 和 `light-theme.css:37` 的对应覆盖。实现时再 grep 一遍，确认全仓没有节点用这个类。

## 3. 状态流

### 3.1 设置键

`translationStyle: 'default'` 加进四张默认值表：
`shared/default-settings.js`、`background/settings.js`、`options/options.js` 的字面量、`popup/popup.js` 的 `defaultSettings`。
`default-settings-agree` 单测会比对。`showTranslationOnly` 已在四张表里。
两个键都不是 batch.js 或引擎读的，所以 `RESTART_KEYS` 不动。

### 3.2 `<html>` 上的两个属性

| 属性 | 谁写 | 含义 |
| --- | --- | --- |
| `data-ai-translator-style` | `display.js` 的 `applyTranslationStyle()` | `normalizeStyle(settings.translationStyle)`；`default` 时移除属性 |
| `data-ai-translator-only` | `visibility.js` 的 `applyTranslationOnlyMode()` 末尾 | `isTranslationOnlyActive()` 为真时存在 |

第二个属性交给 `applyTranslationOnlyMode()` 写，因为所有改变「仅译文是否生效」的路径都已经经过它：设置变化、显隐切换（`setTranslationsVisible`）、fit guard。

### 3.3 应用点

- `ctx.applyTranslationDisplay()`（display.js）：`applyTranslationStyle()`，接着 `ctx.applyTranslationOnlyMode()`，再关掉 peek 卡。
- bootstrap storage 监听：把 :171 的分支换成 `if (changes.showTranslationOnly || changes.translationStyle) ctx.applyTranslationDisplay()`。
- `ctx.init`：`loadSettings()` 之后调用一次 `ctx.applyTranslationDisplay()`。这时还没有译文，`applyTranslationOnlyMode` 相当于空跑，只为把两个属性写对。
- `ctx.setTranslationDisplay(patch)`（display.js，悬浮球用）：`Object.assign(ctx.settings, patch)`，然后 `applyTranslationDisplay()`，最后 `chrome.storage.sync.set(patch)`。
  这和 `content-caption-controls.js:88-93` 的 writeSettings 是同一个写法。本页立即生效，其他标签页经 onChanged 跟上。

## 4. 仅译文下看原文（peek 卡）

- **可看条件**：这条整页译文的原文此刻藏着。
  把 `releaseSourceForTranslation` 里内联的查找抽成 `hiddenSourceOf(translationEl)`：先看前一个兄弟 `.ai-translator-source-hidden`，否则找 holder 里的 `.ai-translator-source-wrap.ai-translator-source-hidden`。
  它公布为 `ctx.hiddenSourceOf`，`releaseSourceForTranslation` 也改用它，保证一份逻辑。
- **原文文本**：`ctx.readSourceText(hidden)`（collect.js:750）。实现时核对它能读 display:none 的节点并排除我们自己的节点；不行就申报并改用 `textContent` 规整空白。
- **触发**（找译文一律走 `event.composedPath()`，理由同 §2.4）：
  - 鼠标：`pointerover` 进入可看的译文，约 350 ms 后开卡。离开译文和卡都约 200 ms 后收卡，可以把指针移进卡里选字。
  - 触屏或笔（`pointerType !== 'mouse'`）：点按切换，只在译文没有交互祖先时生效，规则同 §2.4。
- **收起**：Esc（在 `content-selection.js:78` 的统一 Esc 处加一行 `ctx.hideSourcePeek`，不另挂监听）、页面滚动（window 捕获阶段）、`applyTranslationDisplay()`、点卡外。
  - 滚动收卡要跳过发生在卡**里面**的滚动（`event.target` 在卡内）。卡本身 `overflow: auto`，长原文要在卡里滚着读，否则一滚就没了。
- **已知限制**：锚点译文（`a.ai-translator-inline-block`）是 `pointer-events: none`（translation.css:141-145），悬停和点按都到不了它，peek 开不出来。
  改这条会让链接译文吃掉点击，不在本项内动，列为遗留并在交付报告申报。
- **几何**：`position: fixed`。
  - 默认放在译文矩形下方 6px；放不下就放上方；两边都放不下（译文比视口还高）就贴着指针所在的行。
  - 水平与译文起始边对齐（RTL 对齐右边），夹在视口内，两侧各留 8px。
  - 宽度 `max-width: min(420px, 100vw - 16px)`，高度 `max-height: min(40vh, 320px)`，内容 `overflow: auto`。
  - 卡**不得盖住指针**，否则悬停丢失会立刻收卡。
- **内容**：一行小标签 `sourcePeekLabel`，下面是原文，原文容器 `dir="auto"`。根节点 `role="tooltip"`。
- **宿主 CSS 隔离**：
  - `[id="ai-translator-source-peek"]` 加进 `popup.css` reset 的全部 `:is()` 列表。
  - 自有规则放在 `popup.css` 新段「Source peek」（接在划词卡那段之后），不放 translation.css：
    translation.css 只放页面译文节点的规则（全部 `!important`，享受豁免），P1-A2 还会把它整份注进每个 shadow root，面板规则不该跟着进去。
  - 按现有浮层写法用 id 作用域 `#ai-translator-source-peek`（1,0,0 天然高于 reset 的 0,1,0）。
    **不用 `!important`**：peek 是面板，不是页面译文节点，不享受那条豁免。卡里没有表单控件，不需要 `html body` 控件档。
  - 浅色覆盖放 `light-theme.css`，跟扩展主题 `data-ai-translator-theme`。
  - `host-css-containment` 单测要过。

## 5. 入口

### 5.1 popup：新「显示」行（`popup/popup-display.js`）

- 行放在 `#togglePagePause` 之后，常显。行内三样：
  - 分段按钮「双语 / 仅译文」：两个 `button`，`aria-pressed` 标当前值，文案键 `displayBilingual`、`displayTranslationOnly`。
  - 样式 `<select>`，由 `TranslationDisplay.STYLES` 生成，`aria-label` 用 `translationStyleLabel`。
  - 快捷键 kbd `#translationOnlyShortcut`。
- 点击或改选只写 `chrome.storage.sync.set({…})`，页面经 onChanged 生效，popup 不给标签页发消息。
- `refreshShortcutHint()` 改成按命令名填多个 kbd：一次 `getAll()`，一张「命令名 → kbd」表，不复制函数。
- popup.js 只加：`defaultSettings` 两个键、init 里调用 `setupDisplayRow()`、`elements` 相关几行。行的逻辑全在新模块。
- popup.html 装 `shared/translation-display.js` 和 `popup-display.js`。
- 一行放不下三样时允许折成两行（分段按钮一行，下拉和 kbd 一行）。长语言（de、ru、es）下文案最长，e2e 要断言 popup 没有横向溢出：
  `document.documentElement.scrollWidth <= clientWidth`，行内每个控件的矩形都在 popup 宽度之内。

### 5.2 悬浮球菜单

- 新行 `data-action="toggle-translation-only"`，常显，放在 `toggle-translations` 行的位置之前。
  - 文案随状态：双语时用已有键 `showTranslationOnly`，仅译文时用新键 `showBilingual`。
  - 处理函数调用 `ctx.setTranslationDisplay({ showTranslationOnly: !settings.showTranslationOnly })`。
- **删掉 `menuHeight` 估算**（content-float-ball.js:548-551）。菜单先挂进 body，量 `offsetHeight`，再算 `top`，同一帧内完成，不闪。
  估算把每一行又写了一遍：每加一行都得记得改它，少算了菜单就压住球。P1-A2 也要往这个菜单加一行（§9.1），量出来的高度让两边都不用再碰这一行。
- content-float-ball.js 目前 795 行，只加行与分支，逻辑在 display.js。

### 5.3 快捷键

- manifest `commands` 加 `toggle-translation-only`，`suggested_key.default = "Alt+T"`，`description = "__MSG_cmdToggleTranslationOnly__"`。
  这用掉 P0 的那一个名额，P1 还剩一个。10 个 `_locales` 补 `cmdToggleTranslationOnly`。
- 新模块 `background/commands.js`：`export async function runCommand(command, tab)`，内部是一张「命令名 → 处理函数」表。
  - `toggle-translate-page` 照旧发 `TOGGLE_PAGE_TRANSLATION`，但带上 `{ frameId: 0 }`。
    今天内容脚本只在顶层，这等于现状；P1-A1 让子 frame 也装内容脚本后，这条消息必须只给顶层（P1-A 设计 §4 的钉 frameId 表）。
  - `toggle-translation-only` 读 `showTranslationOnly`（缺省取 `background/settings.js` 的 `defaultSettings`），写回取反值。
  - `background.js` 的 `onCommand` 只转调 `runCommand`。监听必须在 SW 入口顶层同步注册，所以留在 `background.js`。
  - `auto-status-wiring.test.mjs:363-365` 读的是 `background/background.js` 这一个文件，两条断言：
    `onCommand.addListener`（仍在入口，不动）和 `type: 'TOGGLE_PAGE_TRANSLATION'`（搬进 `commands.js` 后会红）。
    后一条改问 SW 全体 `workerSource()`，这是「问面，不问文件」的本意。这是前提改变，交付报告要申报。
- popup 的 kbd 显示 `chrome.commands.getAll()` 报的真实键位，不写死 Alt+T。

### 5.4 设置页

- **样式选择**（`options/options-display.js`）：
  - 在 `showTranslationOnly` 开关后加一个 `<select id="translationStyle">` 和一块预览：一行样例原文，加一个真实的 `span.ai-translator-inline-block` 样例译文。
  - options.html 直接链 `../content/css/translation.css`，预览和页面同一份 CSS，不复制。改选时同步设置本页 `<html data-ai-translator-style>`。
  - 该键走现有管线：加进 `IMMEDIATE_SAVE_FIELDS`、`collectSettings()` 和 `loadSettings()`，与其他字段一致。
  - 预览文案键：`translationStylePreviewSource`、`translationStylePreviewTranslation`。
- **陈旧回写修复**（`options/options-sync-mirror.js`）：
  - 监听 `storage.onChanged`（sync）。对 `IMMEDIATE_SAVE_FIELDS` 里被别处改过的键：
    - 控件值不同就回填（checkbox 用 `checked`，select 用 `value`），不派发 change 事件，避免回写和两个设置页之间来回弹；
    - 同步更新 `lastGoodSettings` 里的同名键（热键冲突回滚用的就是它）；
    - 重跑该键 change 监听里的派生 UI 函数，但不写存储。例如 `translationEngine` → `refreshBuiltinStatus` + `syncAutoEngineState`，`enableSelection` → `syncInlineSettingState`。映射清单在交付报告里逐条列出。
  - 去抖的文本字段（`DEBOUNCED_SAVE_FIELDS`）不镜像，免得打字时被回弹覆盖。
  - 覆盖 `autoTranslate`：popup 的站点开关会顺带打开它，是同一类缺陷。
- options.js（895 行）只加字段接线的几行。options.html（882 行）加一个 select 和预览，约 15 行。

## 6. i18n

十种语言都补 `i18n/lang/*`，按功能成块，追加在 P0-A 的 apiError 块之后。

| 键 | en |
| --- | --- |
| `translationStyleLabel` | Translation style |
| `translationStyleDefault` | Default |
| `translationStyleUnderline` | Underline |
| `translationStyleDashed` | Dashed box |
| `translationStyleHighlight` | Highlight |
| `translationStyleQuote` | Quote bar |
| `translationStyleBlur` | Blur until hovered |
| `hintTranslationStyle` | How translations look on the page. Switching takes effect at once and translates nothing again. Blur is off in translation-only mode. |
| `translationStylePreviewSource` | Reading in two languages at once. |
| `translationStylePreviewTranslation` | 该 UI 语言对上句的翻译 |
| `displayModeLabel` | Display |
| `displayBilingual` | Bilingual |
| `displayTranslationOnly` | Translation only |
| `showBilingual` | Show bilingual |
| `sourcePeekLabel` | Original |

`_locales/*/messages.json` 只加 `cmdToggleTranslationOnly`：「Switch between bilingual and translation only」。

## 7. 测试

### 7.1 单测（新文件 `test/unit/translation-display.test.mjs`，另加必要的扩展）

1. `STYLES` 与 `normalizeStyle`，包括未知值回落。
2. CSS 覆盖双向一致（§2.1），并且每条样式规则都带划词、悬停两个 `:not()`。
3. 不重排白名单（§2.2）：每条样式规则只用白名单属性，全文件的样式规则里不出现 `margin`。
4. 装载清单：manifest 里 `shared/translation-display.js` 在 `content/page/display.js` 之前，`content/page/display.js` 紧跟 `content/page/visibility.js`；popup.html 和 options.html 在各自消费者之前装 `shared/translation-display.js`。
   按 `block-identity.test.mjs:304` 的 globalThis 守卫，把两个新文件放进 e2e 的 `PAGE_TRANSLATION_MODULES`。
5. commands：manifest 带 `suggested_key` 的命令不超过 4 个；`toggle-translation-only` 的键是 Alt+T；10 个 `_locales` 都有 `cmdToggleTranslationOnly`。
   用 stub `chrome` 导入 `background/commands.js`，验证 `runCommand('toggle-translation-only')` 会取反并写回。
6. 四张默认值表都有 `translationStyle: 'default'`。
7. `[id="ai-translator-source-peek"]` 在 reset 的每个 `:is()` 列表里。现有 `host-css-containment` 自动覆盖就不另写。
8. 选择器形状（§9.1-1）：translation.css 里提到 `data-ai-translator-style` / `data-ai-translator-only` 的每个选择器，都以恰好一个 `html` 复合选择器加后代组合符开头，其余部分没有 `html` / `body`。
   变异自检：把一条规则改成 `html body[data-ai-translator-style=…]` 或 `.x html[…]` 时测试要红。

### 7.2 e2e 旅程（验收单元；弹层必带几何断言）

| # | 旅程 | 断言 |
| --- | --- | --- |
| J-C1 | 整页译完，逐一切 6 种样式（块状译文与导航 inline-right 两种形态） | 计算样式符合 §2.4；几何按 §2.2 断言；翻译请求数不变 |
| J-C2 | 真 popup：改样式下拉；点「仅译文」 | 页面实时变化；原文藏起；请求数不变；分段按钮 `aria-pressed` 正确 |
| J-C3 | 悬浮球菜单点新行，再打开菜单点回 | 菜单在视口内、不压球；原文藏起或放回；存储值翻转；文案翻转 |
| J-C4 | 快捷键的效果：SW 写 `showTranslationOnly`（与 `runCommand` 同一写法） | 页面实时切换。按键本身在 headless 下发不出，由 7.1-5 覆盖，如实申报 |
| J-C5 | 仅译文：悬停译文 → 卡；移开；Esc；触屏点按 | 卡可见、文本等于原文、完全在视口内、与译文间距 ≤ 12px、不盖指针；各收起路径生效 |
| J-C6 | blur：默认模糊 → 悬停清晰 → 触屏点按揭开 → 切仅译文后不模糊 | `filter` 计算值 |
| J-C7 | 深色宿主（#111）与浅色宿主（#fff），块状译文 | underline、dashed、quote 的有效装饰色对页面底色 ≥ 3:1；highlight 下文字有效色对有效底色 ≥ 4.5:1。有效色 = 计算色按元素 `opacity` 合成到宿主底色上。inline-right（opacity .7）不断言，见 §2.4 |
| J-C8 | 设置页：改样式看预览；另一面写 `showTranslationOnly=true`，再改一个别的开关 | 预览计算样式变化；复选框被回填；存储里的 `showTranslationOnly` 仍为 true（回归「陈旧回写」） |
| J-C9 | 非 default 样式下的悬停译文和划词译文 | 计算样式与 default 下相同 |

已有的 `translation-only-mode.spec.js` 和 `fit-guard` 系列必须保持绿。

## 8. 文档

- CHANGELOG `## Unreleased` 下新增小节 `### Translation styles and display switch`。
- README 功能列表：六种样式、四个切换入口、看原文卡、Alt+T。每一条都对照真实 DOM 和写入函数写，不写不存在的按钮。

## 9. 不做 / 与 P1 的交界

- 不改 `content/page/insert.js`。万一非改不可，实现方必须申报理由，由主控通知 P1。
- manifest `content_scripts` 归 P1。P0-C 只插两行 js：
  - `shared/translation-display.js`，放在 shared 组的 `shared/default-settings.js` 之后；
  - `content/page/display.js`，放在 `content/page/visibility.js` 之后。

  css 数组不动：peek 卡的样式写进已有的 `popup.css` 和 `light-theme.css`。
- `content-selection.js` 归 P0-D，P0-C 只在 Esc 统一处加一行。
- 受管容器里的译文（原文块自己的 `::after`）不带 `.ai-translator-inline-block` 节点，样式不作用于它。实现方评估：若能用一条同构规则覆盖就做，否则列为遗留。
- 不做逐站点样式、不做自定义颜色、不做「弱化原文」这一类作用在原文上的样式。

### 9.1 与 P1-A（iframe、Shadow DOM）的接口

P1-A 与本项并行开发（设计 `docs/plans/2026-09-24-p1-a-page-coverage.md`，分支 `feat/p1-a-page-coverage`），合并先后未定。下面几条让两边谁先合都成立：

1. **样式选择器的形状是契约。** P1-A2 会把 translation.css 整份注进每个 shadow root，并去掉 `html body ` 前缀。
   shadow 树里没有 `html`，本项的 `html[data-ai-translator-style=…] …` 在里面不会命中。
   本项保证：translation.css 里凡是提到 `data-ai-translator-style` 或 `data-ai-translator-only` 的选择器，都以**恰好一个** `html` 复合选择器开头，后接后代组合符，其余部分不再出现 `html` 或 `body`。
   这样 P1 可以机械地把开头的 `html<复合>` 换成 `:host-context(html<复合>)`（Chrome 支持，manifest 最低 116），样式就进得了 shadow。换不换、怎么换由 P1 定；单测守住形状（§7.1-8）。
2. **每个 frame 都要应用显示设置。** `ctx.applyTranslationDisplay()` 在 `ctx.init` 里跑，P1-A1 的「子 frame 裁剪初始化」不能把它划到只在顶层：子 frame 里的译文同样要有样式、同样受仅译文控制。悬浮球只在顶层，不受影响。
3. **事件找译文用 `composedPath()`**（§2.4、§4），shadow 里的译文也能揭开模糊、开 peek。
4. **快捷键只有一张表。** 本项把 `onCommand` 的分派收进 `background/commands.js`。
   P1-A2 的 `translate-whole-page` 应当是这张表的一行，而不是再挂一个 `onCommand` 监听。谁后合谁收拢。
5. **悬浮球菜单**：本项删掉 `menuHeight` 估算（§5.2），P1 加行时不用再改高度。
6. **可能的文本冲突**：manifest `content_scripts[1].js`（两边都插行）、`visibility.js`（本项改 `applyTranslationOnlyMode` 末尾并抽 `hiddenSourceOf`，P1-A1 改 `setTranslationsVisible` 末尾，P1-A2 改 `:42/:177/:183/:186`）、`content-bootstrap.js` 的 `ctx.init`、`content-float-ball.js` 的菜单 HTML、`_locales/*`。谁后合谁 rebase 消解。

## 10. 决策登记（台账 D-294 起）

1. P0-C 叠在 `feat/p0-a` 上：两者共用 i18n ×10、popup、options、CHANGELOG、README，先合 #104 再合 P0-C。
2. 样式六种，集合与出处见 §2.1；缺省 `default`。
3. 纯 CSS 属性驱动，不改 insert.js。原文永远不动；除 quote 外零几何变化；任何样式不碰 margin（§2.2）。
   quote 用译文自己的起始侧边线 + 内边距。「悬挂边线」会盖掉页面的 `margin: auto` 居中，已否。
4. `blur` 在仅译文时失效，锚点译文不模糊。
5. peek 的条件是「原文藏着」，不是「开关开着」。
6. 快捷键 `toggle-translation-only` 用 Alt+T，用掉 P0 的名额。命令改成 `background/commands.js` 里的表。
7. 设置页陈旧回写一并修，范围是 `IMMEDIATE_SAVE_FIELDS`，不含去抖文本字段。
8. 悬浮球新行常显，不跟「有无译文」走：它是模式偏好，下一次翻译就会按它来。
9. peek 卡的规则放 popup.css，不放 translation.css：后者只装页面译文节点，还要被 P1-A2 注进 shadow root。
10. 悬浮球菜单改为先挂再量高度，删掉 `menuHeight` 估算。
11. 与 P1-A 的五条接口见 §9.1，其中选择器形状由单测守。
