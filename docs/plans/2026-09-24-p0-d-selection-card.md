# P0-D 划词图标 + 译文卡片操作（重译 / 换引擎 / 复制 / 朗读）— 设计

基线：`feat/p0-c` 头 a7ef73e（叠在 P0-C 上，#106 合入后 `git rebase --onto origin/main a7ef73e feat/p0-d`）。
主控：P0 回合主控（Opus 5.5）。实现：dev-opus-high。

## 0. 结论

- 选中文本后，选区末行旁边出现一个 28×28 的圆形图标 `#ai-translator-selection-btn`，点它打开译文卡片。
  卡片固定是卡片，不跟「段落下方 / 弹窗」这个显示方式走（§4.1 说理由）。
- 新同步键 `selectionTrigger`：`icon`（只要图标）/ `modifier`（只要修饰键，即现有行为）/ `both`（两者都要）。**缺省 `both`**。理由：
  1. 不写、不迁移任何已存的键。老用户存下的 `enableSelection`、`selectionTranslationMode`、`selectionTranslationHotkey` 原样生效，修饰键照旧能用。
  2. 关了划词（`enableSelection: false`）的人什么都看不到，图标也不出。
  3. README（:27-28、:120-125）和设置页的提示（`hintSelectionTranslationMode`）一直在承诺「选中后出现翻译按钮」，这个按钮从来没出现过（§1）。缺省 `both` 是兑现这个承诺。
  4. 沉浸式翻译的划词也是图标。
  5. 图标出现不花钱，点了才发请求。
  6. 不想要的人在设置页选一下就关掉。
- 选区翻译只剩一条路：`ctx.translateSelection(text, {range, element})` 按显示方式分派。修饰键、悬浮球、右键菜单三处各自的分叉都删掉，改调它（§3）。
  右键菜单由此在卡片模式下有了等待状态，出错时显示为错误，不再把错误文字当译文显示。
- 卡片新增两个操作。连同原有的复制和朗读，一共四个：
  - **重译**：重新发同一个请求。卡片这条路本来就没有缓存（§1），所以每次重译都是新请求。e2e 数 mock 服务器收到的请求数来守住这一点。
  - **换引擎**：在 Chrome 内置翻译和用户自己的 AI 之间切换，只作用于这张卡，不写设置。
  - **复制**：原有。
  - **朗读**：原有的喇叭按钮，走 `ctx.speech`（`content/content-speech.js`，`speechSynthesis`，本地完成）。本项只加 e2e 断言，不改实现。
- 引擎契约加一个可选字段 `message.engine`（`'builtin' | 'ai'`）。指定了就只用这个引擎，不回落。
  每个响应都带上 `engine`，说明是谁译的。卡片据此显示引擎标签，并决定「换引擎」往哪边换（§6）。
- 新增纯函数 `ctx.placeBeside()`（`content/content-utils.js`），统一「贴着一个矩形放、放不下翻到另一边、再夹进视口」。
  三个用户：P0-C 的看原文卡 `placeCard`（重构到它上面，J-C5 保持绿）、划词卡片、划词图标（§5）。
- 修两处缺陷：
  1. 卡片出错时用 `innerHTML` 覆盖结果区，`.ai-translator-translation-text` 被毁，之后换语言、重译的成功结果都画不出来（§7）。
  2. 右键菜单把 `response.error` 当译文显示（§3）。
- 不加 content 脚本文件，不动 manifest `content_scripts`（归 P1）。设置页新增 `options/options-selection.js`。

## 1. 现状（file:line，基线 a7ef73e）

| 位置 | 现状 |
| --- | --- |
| `content/content-selection.js:91-130` | `showSelectionButton(x, y)` 是死代码：只在 :252 挂到 ctx 上，全仓没有调用者 |
| `content/content-selection.js:16-49` | mouseup 100 ms 后记下 `lastSelectionRange`（克隆）、`lastSelectedText`、`lastSelectionPos`、`lastSelectionElement`，不出任何按钮 |
| `content/content-selection.js:52-57` | mousedown 在按钮外就收按钮 |
| `content/content-selection.js:60-72` | selectionchange：`:64` 的 `if (state.selectionButton \|\| state.selectionTranslationPending) return;` 让按钮在选区清空后也不收 |
| `content/content-selection.js:76-87` | 所有浮层的 Esc 统一在这里收（含 `hideSelectionButton()`） |
| `content/content-selection.js:211-235` | 修饰键：`:230-234` 自己分叉「段落下方 → `translateSelectionInline` / 弹窗 → `showTranslationPopup(text, x, y)`」 |
| `content/content-float-ball.js:620-637` | 悬浮球「翻译选中」：又一份同样的分叉，`:632` 没有位置时退到视口中心 |
| `content/content-messaging.js:95-118` | `TRANSLATE_SELECTION_TEXT`（右键菜单）：先 `await ctx.requestTranslation(...)`，再 `displaySelectionTranslation({translation: response?.error \|\| response?.translation ...})`。**错误被当成译文显示**；弹窗模式没有等待状态 |
| `content/content-messaging.js:85-94` | `SHOW_TRANSLATION`：生产代码里没有发送方，只有 e2e 在用（hover-translation.spec.js :388/:447/:505，image-ocr.spec.js :374） |
| `background/context-menus.js:246-258` | 右键菜单发 `TRANSLATE_SELECTION_TEXT`，自己算好 `targetLang` 一起发；其它入口都由 content 决定目标语言 |
| `content/content-popup.js:144-195` | `showTranslationPopup(text, x, y)`：按估计的 400×250 放在鼠标点右下 10px，放不下往上翻 |
| `content/content-popup.js:94-111` | 操作行：OCR 用的「翻译」按钮（缺省 hidden）+ 复制 |
| `content/content-popup.js:126-142` | 两个喇叭按钮，`ctx.speech.bindSpeakButton`，本地 `speechSynthesis` |
| `content/content-popup.js:445`、`:492`、`:533` | 三处出错都是 `resultBody.innerHTML = '<div class="ai-translator-error">…'`，毁掉 `.ai-translator-translation-text`。之后换语言成功了，`translationTextEl` 是 null，结果画不出来 |
| `content/content-translation-cache.js:65` | 只缓存 `TRANSLATE_BATCH_FAST`；卡片走 `TRANSLATE`，service worker 那头也不缓存 `TRANSLATE` |
| `content/content-translation-engine.js:586-629` | `ctx.requestTranslation`：引擎只看设置（`isBuiltinSelected(auto)`），响应不说是谁译的 |
| `content/hover/selection.js:212-321` | `translateSelectionInline`：段落下方模式自己发请求，有加载点，`response.error` 按 `isError` 画，这一路是对的 |
| `content/css/selection-button.css` | 死按钮的样式：`#ai-translator-selection-btn` ID 选择器、渐变胶囊 |
| `content/css/popup.css:13-44`、`:292-296` | 卡片 `max-height: 480px`；`.ai-translator-content` `max-height: 340px` 内部滚动 |
| `options/options.html:364-396` | 「划词翻译」行（开关 + 显示方式下拉）、「划词快捷键」行 |
| `options/options.js:823-830` | `syncInlineSettingState()`：关了划词就禁用显示方式和快捷键 |
| `options/options.js:414-442` | 划词与悬停快捷键冲突检测与回退 |
| `i18n/lang/*.js` `hintSelectionTranslationMode` | 「选中文本后显示翻译按钮……」——承诺了一个不存在的按钮 |
| README.md:27-28、:120-125 | 「Shows a translate button when text is selected」「Click the "Translate" button that appears」——同上 |

## 2. 设置

### 2.1 新键 `selectionTrigger`

- 取值 `'icon' | 'modifier' | 'both'`，缺省 `'both'`，理由见 §0。
- 只加进两张默认值表：`shared/default-settings.js` 的 `CONTENT_DEFAULTS` 和 `options/options.js` 的 `defaultSettings`。popup 和 service worker 不读它。
  `test/unit/default-settings-agree.test.mjs` 守住两表一致。
- 不写迁移，不在 onInstalled 里写种子值。老用户没存过这个键，读到的就是缺省值。

### 2.2 两个设置各管什么

| 设置 | 管什么 |
| --- | --- |
| `enableSelection` | 总开关。关了，图标和修饰键都不起作用（现状如此，不变） |
| `selectionTrigger` | 选中之后**怎么触发**：出图标、按修饰键，或两者都要 |
| `selectionTranslationMode` | 修饰键、悬浮球、右键菜单触发时译文**画在哪**：段落下方或卡片。图标不看它，总是开卡片 |
| `selectionTranslationHotkey` | 哪个修饰键。`selectionTrigger === 'icon'` 时不起作用 |

## 3. 选区翻译只剩一条路

在 `content/content-selection.js` 新增：

```js
// 按显示方式分派：段落下方 → translateSelectionInline；卡片 → showTranslationPopup。
ctx.translateSelection = function(text, { range, element }) { … };
```

- 段落下方模式：`ctx.translateSelectionInline(text, element, range)`。已有加载点、按请求号丢弃过期响应、`isError` 画错误。
- 卡片模式：`ctx.showTranslationPopup(text, { range })`。已有等待状态，出错走 §7 的错误元素。
- 开始之前先收图标。

改调它的三处（各自的分叉删掉）：

1. 修饰键 `runSelectionHotkey`（`content-selection.js:230-234`）。
2. 悬浮球 `handleMenuAction('translate-selection')`（`content-float-ball.js:629-634`）。
3. 右键菜单 `TRANSLATE_SELECTION_TEXT`（`content-messaging.js:95-118`）：
   - 不再在这里 `await requestTranslation`，也不再经过 `displaySelectionTranslation`。
   - `range` / `element` 用修饰键同一个解析函数（`resolveSelectionRange` 那一套）取当前选区，取不到退回 `state.lastSelection*`。
   - `background/context-menus.js` 不再发 `targetLang`：目标语言和其它入口一样由 content 决定（`ctx.getEffectiveTargetLang()`），只有一个决定者。

两件事保留原样，登记为遗留：

- `SHOW_TRANSLATION` 与 `displaySelectionTranslation`：生产代码不发它，只有 e2e 在用。清理要改那几个 e2e，不在本项范围。
- `state.lastSelectionPos`：卡片改用选区矩形定位后，这个字段没有读者了，**删掉**（bootstrap :44 的初值、`resolveSelectionPosition`、悬浮球 :632 的视口中心兜底）。
  没有选区矩形时，卡片居中（§5.3）。

## 4. 图标

### 4.1 点图标总是开卡片

- 卡片是四个操作所在的地方。段落下方模式没有操作按钮。
- 显示方式的缺省值是段落下方。如果图标跟着显示方式走，缺省配置下点图标永远见不到卡片，验收旅程「选中 → 图标 → 卡片 → 重译 / 换引擎」就走不通。
- 沉浸式翻译的图标也是开卡片。
- 显示方式继续管修饰键、悬浮球、右键菜单。设置页的提示按这个意思改写（§9）。

### 4.2 结构与样式

```html
<div id="ai-translator-selection-btn">
  <button type="button" class="ai-translator-selection-icon" aria-label="{selectionIconLabel}" title="{selectionIconLabel}">
    <svg …翻译图标…/>
  </button>
</div>
```

- 28×28，圆形，`position: fixed`，z-index 取最大值。
  SVG 用卡片标题里那个翻译图标，抽成一个常量共用，不再复制第三份路径。
- `mousedown` 上 `preventDefault()` 和 `stopPropagation()`：点图标不能把选区点没了。
- 样式重写 `content/css/selection-button.css`（manifest 里已经有它，数组不动）：
  - 删掉所有 `#ai-translator-selection-btn` 规则和 `!important`，`@keyframes ai-translator-btn-pop` 保留。
  - 控件规则写成 `html body [id="ai-translator-selection-btn"] .ai-translator-selection-icon`，特异性 (0,2,2)；`:hover` / `:focus-visible` 在此基础上加伪类。
  - 浅色覆盖写成 `html[data-ai-translator-theme="light"] body …`。
  - 根已经在 popup.css 重置的 `:is()` 列表里；`test/unit/host-css-containment.test.mjs` 守住。

### 4.3 什么时候出现

只在 mouseup 之后那 100 ms 的结算里出现，条件全部满足：

- `enableSelection` 开着，且 `selectionTrigger` 是 `icon` 或 `both`；
- 选中文字 2–5000 字（与现有记录条件同一个判断）；
- 选区不在可编辑元素里，也不在我们自己的界面里（`isSelectionTriggerIgnored`，与修饰键同一个判断）。

键盘做出来的选区（Shift+方向键）不出图标，这是有意的：没有鼠标落点，也就没有「旁边」。

修饰键只在 `selectionTrigger` 是 `modifier` 或 `both` 时起作用；是 `icon` 时 `handleSelectionHotkey` 直接返回，不 arm。

### 4.4 放在哪

- **末行**：选区焦点（`focusNode` / `focusOffset`）处一个折叠 Range 的矩形，就是鼠标松开那一端所在的行。
  这个矩形为空（例如焦点落在元素边界上）时，取选区 `getClientRects()` 里离 mouseup 点最近的那个。
- **上下**：
  - 反向拖出来的多行选区（焦点在锚点之前），末行是选区的第一行，图标优先放在它**上方**；
  - 其余情况优先放在末行**下方**。
  - 这样有地方时图标不盖选区。
- 间距 6px。
- **水平**：以 mouseup 的 x 为中心，先夹到末行的左右范围内，再夹进视口（两侧留 8px）。
- 计算交给 `ctx.placeBeside()`（§5），锚点是末行矩形。

### 4.5 什么时候收

| 事件 | 做法 |
| --- | --- |
| 滚动 | capture、passive 监听，出图标时挂上，收图标时摘掉 |
| 窗口 resize | 同上 |
| Esc | 统一 Esc 处理已经调 `hideSelectionButton()` |
| 在图标外按下鼠标 | 现有 `:52-57` |
| 选区清空 | 从 `:64` 的守卫里去掉 `state.selectionButton`（保留 `selectionTranslationPending`）。图标 mousedown 不丢选区，这个守卫已经不需要了 |
| 卡片打开、任何一条选区翻译开始 | `translateSelection` 和图标点击都先收图标 |
| 设置变化（`enableSelection` 关、`selectionTrigger` 变成 `modifier`） | 一个函数 `syncSelectionIcon()`，由 bootstrap 的 storage 监听和 `SETTINGS_UPDATED` 两处调用 |

**点击**：`ctx.showTranslationPopup(state.lastSelectedText, { range: state.lastSelectionRange })`，然后收图标。

## 5. `ctx.placeBeside()`（`content/content-utils.js`，纯函数）

```
placeBeside(size, anchor, options) → { left, top, maxHeight }

size    = { width, height }
anchor  = { left, top, right, bottom }            // 视口坐标
options = { viewport: { width, height }, gap = 6, margin = 8,
            prefer = 'below' | 'above', x, rtl = false,
            fallback = null /* 另一个矩形 */, minHeight }
maxHeight = null，除非是「缩高」那一步选出来的
```

### 5.1 竖直方向，按顺序取第一个成立的

1. 优先的那一侧放得下；
2. 另一侧放得下；
3. 给了 `minHeight` 时，两侧里空间大的那一侧，只要空间不小于 `minHeight`：放在那侧，`maxHeight` 等于那侧的空间；
4. 给了 `fallback` 时，贴着 `fallback` 放：下方放得下放下方，否则上方放得下放上方，否则放空间大的一侧（有 `minHeight` 时同样给 `maxHeight`）；
5. 最后把 `top` 夹进 `[margin, viewport.height - margin - 实际高度]`。

### 5.2 水平方向

- 给了 `x` 就用 `x`；否则与锚点起始边对齐：LTR 取 `anchor.left`，RTL 取 `anchor.right - width`。
- 然后夹进 `[margin, viewport.width - margin - width]`。

### 5.3 三个用户

| 用户 | 锚点 | 选项 |
| --- | --- | --- |
| P0-C 看原文卡 `placeCard`（`content/page/display.js:176-209`） | 译文矩形 | `prefer: 'below'`，`rtl` 取译文的计算方向，`fallback` 取指针所在行（`lineRectAt`，没有就取指针上下 1px） |
| 划词卡片 | 选区外接矩形 | `prefer: 'below'`，起始边对齐，`rtl` 取选区元素的计算方向，`minHeight` ≈ 160，`fallback` 取末行 |
| 划词图标 | 末行矩形 | `prefer` 见 §4.4，`x` 见 §4.4 |

- `placeCard` 重构后只保留自己那一步「夹完仍罩住指针就翻到指针上方」，J-C5（含「不盖指针」）必须保持绿。
- 读 `ctx.placeBeside` 发生在调用时，不依赖 manifest 里谁先加载。

### 5.4 卡片自身的布局改动

- `.ai-translator-popup` 改为纵向 flex，宽度 `min(400px, 100vw - 16px)`。
- `.ai-translator-content` 加 `min-height: 0`，放不下时缩高、内部滚动。
- `placeBeside` 给出 `maxHeight` 时写到卡片的内联 `max-height` 上。
- `showTranslationPopup(text, { range })` 取代 `(text, x, y)`：
  - 打开时存下 `range` 的克隆和当时的外接矩形。
  - 卡片尺寸每次变化都重新放一次（一个 `ResizeObserver`；加载 → 结果 → 错误 → 操作行出现都会变），直到用户拖动过卡片。
  - 重新放时先用存下的 Range 算矩形，Range 的节点已经不在文档里（矩形全 0）就用存下的矩形。
  - 没有 `range` 时居中。
- OCR 卡片（`showTranslationResult`）保持居中，不改。
- 卡片是 `position: fixed`，页面滚动时不跟着选区走，与现状一致。

## 6. 卡片操作与引擎契约

### 6.1 操作行

`.ai-translator-actions` 加 `flex-wrap: wrap`，仍然靠尾端对齐。DOM 顺序：

1. OCR 的「翻译」按钮（已有，缺省 hidden）
2. 「重译」`.ai-translator-retranslate`
3. 「换引擎」`.ai-translator-switch-engine`
4. 「复制」（已有）

结果区标题行（「译文」旁边）加引擎标签 `.ai-translator-engine-tag`。它的文字由 `response.engine` 决定：`cardEngineBuiltin` 或 `cardEngineAi`。不知道是哪个引擎译的就隐藏。

### 6.2 重译

- 第一个响应结算（成功或失败）之前隐藏；有请求在路上时禁用。
- 点击：用卡片当前的原文、当前目标语言重发同一个请求。只有这张卡已经固定了引擎（`dataset.pinnedEngine`）时才带 `engine`。
- 卡片这条路没有缓存，所以重译就是新请求。**不加一个没人读的 `fresh` 标志**。
  以后谁给 `TRANSLATE` 加缓存，J-D1 的「重译后 mock 收到的请求数 +1」会红，逼着那次改动让重译绕过缓存。
- 两个按钮只由 `translateText` 的结算打开。`showTranslationResult` 直接给出的结果不带它们（不知道是哪个引擎译的）。OCR 卡片点了「翻译」之后走 `translateText`，按钮照常出现。

### 6.3 换引擎

- 按钮文字说的是**换到哪边**：`cardUseBuiltin`（改用 Chrome 内置翻译）或 `cardUseAi`（改用我的 AI 模型）。
- 三个条件都满足才显示：
  1. 卡片已结算；
  2. `response.engine` 已知；
  3. 另一边此刻可用。由异步的 `ctx.engineChoices(targetLang)` 回答：先 `refreshAiConfig()`，再返回 `{ builtin: isBuiltinSupported() && eng.supportsLang(eng.toApiLang(targetLang)), ai: aiConfigured() }`。`targetLang` 是卡片当前的目标语言（`dataset.targetLang`）。内置一侧与语言菜单的「仅 AI」标记用同一个判定（见 §15）。
- 点击：写 `dataset.pinnedEngine`，带 `engine` 重发。之后换语言下拉和重译都带这个 `engine`。按钮随即改为提供换回去。
- 只按目标语言判断内置翻译能不能用：目标语言不在内置引擎的清单里（菜单标「仅 AI」的那些），就不给「换到内置」。不预先判断源语言这一侧；这一对不支持时返回真实原因（`UNSUPPORTED_PAIR` 的文案），按 §7 显示为错误。
- 什么都不写进设置：这是对一张卡的一次比较，全局引擎在设置页和 popup 里另有入口。

### 6.4 引擎契约（`content/content-translation-engine.js`）

- `message.engine` 只能是 `undefined`、`'builtin'`、`'ai'`，其它值直接抛错（调用方写错了，不静默当成没传）。
- `wantsBuiltin(message, auto)`：指定了 `engine` 就听它的，否则按设置 `isBuiltinSelected(auto)`。
  P1-B 以后的 `engineOverride` 排在设置之上、`message.engine` 之下：显式的一次请求压过任何偏好。
- 指定了引擎就**不回落**：
  - 指定 `builtin`，而环境不支持或内置翻译失败 → 返回 `{ error: 真实原因, engine: 'builtin' }`。`engineFallback: 'allow-ai'` 也不回落，因为用户点的就是「用内置」。
  - 指定 `ai` → 完全跳过内置翻译那一段。
- 每个响应都盖上 `engine`：
  - 内置翻译成功 → `'builtin'`。
  - 走 AI 的（包括回落、预算拒绝）→ `'ai'`：`const r = await chrome.runtime.sendMessage(message); return r && { ...r, engine: 'ai' };`。
  - 出错时，知道是哪个引擎就盖上。
- 什么都不持久化。

## 7. 卡片的错误显示

- `.ai-translator-translation` 里加一个独立的 `.ai-translator-error`（初始 hidden），与 `.ai-translator-translation-text` 并列。
- 一个函数 `showCardError(popup, message)` 负责三处出错（`:445`、`:492`、`:533`）：
  - 关掉加载态；
  - 用 `textContent` 写入错误元素并显示；
  - 清空并隐藏译文元素（旧译文是另一次请求的结果，留着会被当成这次的）；
  - 藏起朗读译文按钮。
  - 不再有 `innerHTML`。
- 之后任何一次成功都先隐藏并清空错误元素。
- 顺带 B-P0A-1：`.ai-translator-error` 加 `white-space: pre-line`，`describeAPIFailure` 的多行错误按行显示。

## 8. 设置页

- 「划词翻译」行与「划词快捷键」行之间新增一行「划词触发方式」：
  - 下拉 `#selectionTrigger`，三项：图标 / 修饰键 / 图标和修饰键；
  - 提示 `hintSelectionTrigger`。
- 新文件 `options/options-selection.js`，在 options.html 里放在 `options.js` 之前（与 `options-display.js` 同一模式）。它拥有 `syncSelectionControls()`：
  - `enableSelection` 关 → 触发方式、显示方式、快捷键全部禁用；
  - 触发方式为 `icon` → 只禁用快捷键。**显示方式不禁用**：悬浮球和右键菜单还在用它。
  - `syncInlineSettingState()`（`options.js:823-830`）里关于划词的两行挪过来，只留悬停那一行。
- 冲突检测：
  - `hasHotkeyConflict` 加一个条件 `&& settings.selectionTrigger !== 'icon'`：只用图标时划词快捷键不生效，与悬停快捷键相同也不算冲突。
  - `selectionTrigger` 加入 `CONFLICT_FIELDS`：两个快捷键相同的情况下，把触发方式从 `icon` 改回来会产生冲突，这次改动被回退，与改快捷键时一样。
- 值的通路仍在 `options.js`：`IMMEDIATE_SAVE_FIELDS`、`loadSettings`、`collectSettings`、`defaultSettings` 各一行。options.js 已 903 行，逻辑放新文件。

## 9. i18n

十种界面语言（`i18n/lang/*.js`）各追加一块 `// Selection icon and card actions (P0-D)`，`_locales/*` 不动。

| 键 | en | zh-CN |
| --- | --- | --- |
| `selectionTrigger` | Selection trigger | 划词触发方式 |
| `selectionTriggerIcon` | Icon | 图标 |
| `selectionTriggerModifier` | Modifier key | 修饰键 |
| `selectionTriggerBoth` | Icon and modifier key | 图标和修饰键 |
| `hintSelectionTrigger` | Icon: a small button appears next to the selected text; click it to open a translation card. Modifier key: press the key below to translate at once. | 图标：选中文本后旁边出现一个小按钮，点它打开译文卡片。修饰键：按下方设置的键直接翻译。 |
| `selectionIconLabel` | Translate selection | 翻译选中文本 |
| `cardRetranslate` | Retranslate | 重译 |
| `cardUseBuiltin` | Use Chrome built-in | 改用 Chrome 内置翻译 |
| `cardUseAi` | Use my AI model | 改用我的 AI 模型 |
| `cardEngineBuiltin` | Chrome built-in | Chrome 内置 |
| `cardEngineAi` | My AI | 我的 AI |

改写 `hintSelectionTranslationMode`（十种语言都改）：

- en：Where a translation from the modifier key, the float ball or the right-click menu appears: inline below the paragraph, or in a popup card. The selection icon always opens a card.
- zh-CN：修饰键、悬浮球和右键菜单的译文显示在哪里：段落下方，或弹出卡片。划词图标总是打开卡片。

措辞与已有的 `engineBuiltin`（Chrome 内置翻译（免费、离线））和 `engineCustomAi`（我的 AI 模型）保持一致。卡片上的标签用短形式。

## 10. 测试

### 10.1 单测

1. `placeBeside`：下方、上方、两侧都放不下时缩高、`fallback`、夹进视口、RTL 起始边、`x` 优先。用 vm 跑真代码，做法同 `modifier-tap.test.mjs`。
2. 引擎（`test/unit/helpers/engine-harness.mjs`）：
   - `engine` 取值校验（非法值抛错）；
   - 指定 `builtin` 失败不回落（`engineFallback: 'allow-ai'` 下也一样）；
   - 指定 `ai` 不碰内置翻译；
   - 各条路径的 `engine` 盖章。
3. 设置页：触发方式为 `icon` 时 `hasHotkeyConflict` 为 false。
4. 已有守卫覆盖其余：`default-settings-agree`（两表一致）、i18n 十语言键集一致、`host-css-containment`（图标新规则的特异性）。

### 10.2 e2e 旅程（验收单元；浮层必带几何断言）

新 spec `test/e2e/selection-card.spec.js`。内置翻译用 CDP 在 content script 的隔离世界里打桩（`Runtime.evaluate` 替换 `self.Translator`，返回 `'[B] ' + 原文`，明确标注为打桩）。把 P1-A 在 `frames.spec.js` 里的 `evaluateInContentScript` 提进 `test/e2e/helpers.js` 共用。

| 旅程 | 检查什么 |
| --- | --- |
| J-D1 | 真鼠标拖选 → 图标出现：离末行不超过 12px、在视口内（留 8px）、不与选区任何一个 client rect 相交 → 点图标 → 卡片在视口内、不盖选区、标签是「我的 AI」 → 重译：mock `sentTexts` +1 → 换到内置（打桩）：`sentTexts` 不变、译文以 `[B] ` 开头、标签变「Chrome 内置」 → 换回 AI：`sentTexts` +1 → 复制 → 朗读按钮在 |
| J-D2 | 第一次请求出错 → `.ai-translator-error` 显示错误，`.ai-translator-translation-text` 仍在 DOM → 重译成功 → 错误隐藏、译文显示 |
| J-D3 | 右键菜单出错（从 service worker 发 `TRANSLATE_SELECTION_TEXT`）：卡片模式先有等待状态，再显示为错误；段落下方模式按 `isError` 画。两种模式都不把错误文字当译文 |
| J-D4 | 触发方式 `modifier`：拖选后不出图标；修饰键照常翻译 |
| J-D5 | 触发方式 `icon`：修饰键无效（不发请求、不出译文）；图标照常 |
| J-D6 | 设置页：三种禁用状态；两个快捷键相同时的冲突回退（改快捷键、改触发方式两种） |
| J-D7 | 图标在滚动、Esc、图标外按下、选区清空时各自收掉 |
| J-D8 | 在 input、textarea、contenteditable 里选中不出图标 |
| J-D9 | 十种界面语言下，重译和换引擎都显示时操作行不溢出卡片 |
| J-D10 | 选区贴近视口底部时卡片放到选区上方；超长原文时卡片缩高、内容区内部滚动，卡片仍在视口内 |

必须保持绿：J-C5（看原文卡，`placeCard` 重构后）、image-ocr、hover-translation，以及现有的划词、右键菜单相关 spec。

## 11. 文档

- README：
  - 功能列表（:27-28）写图标、触发方式设置、Ctrl/⌘ 修饰键、卡片四个操作；
  - 用法（:120-125）按真实 DOM 改写；
  - 其余提到划词的段落 grep 一遍，一并对齐。
- CLAUDE.md：
  - :69 的「selection button」和 :162 的「select text and press the button」改为触发方式与显示方式的分工；
  - Translation Engine 一节补 `message.engine` 契约（指定即不回落、响应盖章）。
- CHANGELOG `## Unreleased` 下新增小节 `### Selection icon and card actions`。

## 12. 不做 / 与 P1 的交界

- 不加 content 脚本文件，manifest `content_scripts` 的 js 和 css 数组都不动。`selection-button.css` 已在 manifest 里，只重写内容。
- `content-selection.js`、`content-popup.js` 归 P0-D。P1 的「加入术语表」按钮等 P0-D 合入后，加在操作行「换引擎」和「复制」之间。操作行已经 `flex-wrap`，J-D9 会替它检查十语言下放不放得下。
- `message.engine` 与 P1-B 的 `engineOverride`：显式请求 > 站点覆盖 > 设置（§6.4）。
- P1-A 的中继（子 frame 的请求）会把 `engine` 字段一起带过去。子 frame 里 `ctx.engineChoices(targetLang)` 的回答偏保守，#107 合入后与 P1-A 核对，列为遗留。
- 以后给 `TRANSLATE` 加缓存的改动必须让重译绕过缓存，J-D1 守着。
- 可能的文本冲突：`content-translation-engine.js`（P1-A 中继）、`content-messaging.js`、`test/e2e/helpers.js`、i18n 表尾部、CHANGELOG、README。谁后合谁 rebase 消解。
  #107 先合的话，`frames.spec.js` 改为从 helpers.js 导入 `evaluateInContentScript`（机械改动，告知 P1）。
- 不做：键盘选区出图标、图标跟随滚动、卡片跟随滚动、生词本、多引擎并排对照。

## 13. 决策登记（台账 D-301）

1. `selectionTrigger` 三值，缺省 `both`，不迁移、不写种子；理由见 §0。
2. 图标总是开卡片；显示方式只管修饰键、悬浮球、右键菜单。
3. 选区翻译收成一条路 `ctx.translateSelection`；右键菜单不再在 background 算目标语言；`lastSelectionPos` 删除。
4. `placeBeside` 是三个浮层的唯一放置实现，P0-C 的 `placeCard` 重构到它上面。
5. `message.engine` 指定即不回落，响应一律盖 `engine`；换引擎只作用于一张卡，不写设置。
6. 重译不加 `fresh` 标志，靠 J-D1 数请求守「绕过缓存」。
7. 卡片错误进独立元素、只用 `textContent`，译文元素不再被毁。
8. 设置页逻辑进 `options/options-selection.js`；触发方式为 `icon` 时不禁用显示方式，快捷键冲突不计。
9. `SHOW_TRANSLATION` 死路与它的 e2e 替身留作遗留，不在本项清理。

## 14. 实现偏差（实现时登记）

（实现方在此逐条登记与本设计不一致之处、原因和证据。）

1. **末行的取法（§4.4）**：`selectionLineRect`（`content/content-selection.js:114`）用焦点处折叠 Range 的矩形只判定「是哪一行」，锚点取选区 `getClientRects()` 里落在这一行上的那段矩形，而不是折叠 Range 本身那个零宽矩形——§4.4 的「水平先夹到末行左右范围内」需要这一行被选中部分的左右边。折叠 Range 矩形为空时，用 mouseup 的 y 在选区矩形里取竖直距离最近的一段。J-D1 断言图标离这一段不超过 12px。
2. **OCR 出错也走 `showCardError`（§7）**：§7 只点名了 `content-popup.js` 里的三处出错；OCR 自己的 `renderOcrFailure` 是第四份同样的「关加载态、写错误」，已删，两处调用改为 `ctx.showCardError`（`content/content-image-ocr.js:344`、`:349`）。错误元素因此在 OCR 卡片上也是同一个 `.ai-translator-error`。
3. **`ctx.engineChoices(targetLang)` 自身失败（§6.3 未写）**：`settleCardActions`（`content/content-popup.js:534`）在它抛错时打一行 `console.error`（`:549`）并保持「换引擎」隐藏；重译照常可用。不猜另一边能不能用。
4. **禁用态样式（§6.2 未写）**：「有请求在路上时禁用」需要看得出来，`content/css/popup.css:639` 加 `.ai-translator-btn:disabled`（半透明、默认光标），作用域只到卡片和输入框对话框。
5. **e2e 助手的来源**：J-D1/J-D9 要在 content script 的隔离世界里给 `self.Translator` 打桩，`test/e2e/helpers.js:475` 的 `evaluateInContentScript` 照搬自 P1-A 分支 `test/e2e/frames.spec.js:318`（CDP 找扩展的 isolated context）。两边合入后应只留 helpers.js 这一份。打桩本身是 `stubBuiltinTranslator`（`helpers.js:498`），回答 `'[B] ' + text`，明写为 STUB。
6. **既有测试的一处改动**：`test/e2e/local-model-no-key.spec.js:87` 由 `toHaveCount(0)` 改为 `toBeHidden()`。旧前提：成功时卡片里没有错误元素；新前提：错误元素常驻、成功时隐藏（§7 的单一错误元素）。

## 15. rebase 到 P0-B / P0-F 之后的接缝

分支 rebase 到 P0-F（其下是已合入的 P0-B）之后补的几处。B 的设计 §12 把三件事交给后合入的一方，这里由 D 做：

1. **打开语言菜单时把已选项滚进视野**：`setupLanguageDropdown` 的 `openMenu` 在 `menu.hidden = false` 之后调用 `ctx.revealSelectedLanguage(menu)`（`content/content-popup.js`）。只改菜单自己的 `scrollTop`，宿主页面不滚。划词卡和输入框对话框共用这个函数，一行两处都覆盖。J-B8（输入框对话框）和 J-B9（划词卡）断言：已选项落在菜单可视框内（±1px）、`scrollTop > 0`、`window.scrollY` 不变。
2. **划词卡译文标 `lang` / `dir`**：`translateText` 每次成功结算都对译文元素调用 `ctx.markLanguage(el, targetLang)`；右键菜单的 `showTranslationResult` 在 `setupLanguageDropdown` 写下规范化目标语言之后同样标一次。只标译文元素，加载态、错误和原文是别的元素，不标。`popup.css` 的 `.ai-translator-translation-text` 加 `text-align: start`，否则宿主页面 `body` 上的 `text-align: left` 会继承进来，把 RTL 译文钉在左边。J-B9 在 `he` 下量第一行右缘贴内容框右缘（±1px）、左缘离内容框左缘大于 10px；改选 `en` 后重译，量第一行左缘贴内容框左缘（±1px）。
3. **J-B9 旅程**：放在 `test/e2e/target-languages.spec.js`，文件头注释已登记。

另外两处：

4. **换引擎按目标语言**：`ctx.engineChoices()` 改为 `ctx.engineChoices(targetLang)`。内置一侧用 `eng.supportsLang(eng.toApiLang(targetLang))`，与 `buildTargetLangMenu` 标「仅 AI」的判定是同一个组合。例如目标 `fa` 时不给「换到内置」，目标 `fr` 时给。单测 `test/unit/engine-pin.test.mjs` 逐语言对照判定；J-D1 在卡片上依次改选 `fa`、`fr` 断言按钮随之隐藏、出现。
5. **导入校验 `selectionTrigger`**：`shared/settings-transfer.js` 的 `buildEnums` 加上 `selectionTrigger: ['icon', 'modifier', 'both']`，导入文件里不在这三个值里的值落进 `dropped`。`test/unit/settings-transfer.test.mjs` 加了反向检查：`options.html` 里每个 id 属于设置 schema 的 `<select>`，都必须在 enums 里有一项，下一个漏登记的下拉框会在单测里变红。
