# P0-F 首装引导页 + 设置导入导出 — 设计

- 基线：`6ca5e98`（叠在 P0-B 之上）。行号都按这个基线写。
- 台账：D-306（待主控确认编号）。
- 验收单位：带几何断言的 e2e 旅程（§10.2）。
- 标「P1 协调 2026-09-25」的条目是 P1 会话回的协调意见，覆盖任务书原文。

## 0. 结论

1. **首装时打开一页引导。**
   - 只在 `onInstalled` 的 `reason === 'install'` 时开。更新和 Chrome 升级都不开。
   - 页面是新顶层目录 `onboarding/`，进 zip。
   - 页面有四块：
     - 端上引擎状态（带「下载语言包」按钮，由用户点）；
     - 目标语言；
     - 引擎选择：默认「端上」，另一个选项是「配置 AI」，下分本机 Ollama、本机 LM Studio 和云端 API；
     - 快捷键。
2. **引导页不另写一套逻辑。**
   - 端上状态的判定和下载从 `options/options-builtin.js` 抽到 `shared/language-pack.js`，两页共用。
   - 广播 `SETTINGS_UPDATED` 和 `LANGUAGE_PACK_READY` 从 `options/options.js` 抽到 `shared/tab-broadcast.js`，两页共用。
   - 连接表单不抄。选了 AI，就把用户送到设置页的连接卡片（`options.html#apiSettingsCard`）。
3. **设置可以导出成一个 JSON 文件，也可以导入回来。**
   - 设置页新增一张卡片，文件格式是 `{format:'blab-settings', version:1, exportedAt, settings, siteRules}`。
   - API Key 默认不导出，勾选后才带上。
   - 导入流程：先整份校验，再给出预览，确认后才写入。坏文件一个字节都不写。
   - 站点规则的导入走服务工作者的单写者队列，新增一种写入 `import`。
4. **修文档里的过时事实。**
   - 仓库地址改成 `FutrixDev/translator`。
   - 分批数字按 `content/page/batch.js` 的实际值改。
   - README 补引导页和导入导出两节，CHANGELOG 在 `## Unreleased` 下补一节。

### 兼容影响（已发布客户端的存储契约）

- **存储键和值都不变。**
  - 引导页只写已有的键：`targetLang`、`translationEngine`、`provider`、`apiEndpoint`、`modelName`。取值范围和设置页相同。
  - 导入也只写 `defaultSettings ∪ CONTENT_DEFAULTS` 里已有的键，外加 `siteRules`。
- **老用户升级不受影响。**
  - `reason === 'update'` 不开引导页。
  - 老用户第一次看到的变化，只是设置页多了一张「导入导出」卡片。
- **新增的对外契约只有导出文件格式 `blab-settings` v1。**
  - 这是新格式，没有旧版本需要兼容。
  - 以后改格式时 `version` 加一，导入端按 `version` 分支处理。本版只认 1，其他版本明确拒绝。
- **中途放弃 AI 配置的新用户。**
  - 在引导页选了「配置 AI」、到了设置页又没填 Key 的人，存储里已经是 `translationEngine:'ai'`。
  - 他打开 popup 会看到 `apiNotConfigured`（「请先配置 API」）。这是预期行为：
    - 状态如实报告了他的选择；
    - 那句话本身就告诉他下一步去哪儿。
  - 我们不在引导页把引擎悄悄退回端上，因为那是替他改主意。

## 1. 现状（file:line，基线 6ca5e98）

### 1.1 首装：什么都不开

- `background/background.js:275-279`：`onInstalled` 只建右键菜单、登记 PDF 轮询闹钟和缓存清扫闹钟。回调不接 `details`。
- 新用户装完之后，只能自己点图标。默认目标语言跟随浏览器、默认端上引擎，这两件事他都不知道；语言包要下载这件事他也不知道。

### 1.2 端上引擎状态只在设置页

- `options/options-builtin.js:16-115` 这一段做四件事：
  - 用 `refreshBuiltinStatus()` 判定 en→目标语言的状态；
  - 用 `downloadLanguagePack()` 下载语言包；
  - 用 `BUILTIN_PROBE_SOURCE` 作探测的源语言；
  - 下载完调用 `broadcastLanguagePackReady()`。
- 判定逻辑和 DOM（`elements.*`）、表单值（`elements.targetLang.value`、`elements.engineFallback.value`）搅在一起。第二个页面没法复用。
- 广播函数在 `options/options.js:511-555`：`notifyContentScripts(settings)` 和 `broadcastLanguagePackReady(targetLang)`。两者都是 `tabs.query({})` 加逐个 `sendMessage`。

### 1.3 没有导入导出

- 设置页全部内容存在 `chrome.storage.sync`，换机器要靠 Chrome 同步。
- 没登录 Chrome 同步的用户、或者想备份和分享一份配置的用户，没有办法。
- 站点规则写入在 `shared/site-rules.js:497-560`：只有 `rule` 和 `ask` 两种，每次只写一条。

### 1.4 过时事实

| 位置 | 现在写的 | 实际 |
|---|---|---|
| `options/options.html:793` | `github.com/wangqianqianjun/translator` | `github.com/FutrixDev/translator` |
| `README.md:95`、`:325` | 同上（`git clone`） | 同上 |
| `README.md:45` | 100 items/batch, 8 concurrent | 每批最多 40 条或 9000 字符；并发端上 4、AI 12（`content/page/batch.js:24-31`） |
| `README.md:284` | 100条/批，8并发 | 同上 |
| `CLAUDE.md:66` | 8 workers, max 2500 chars or 25 items per batch | 同上 |

## 2. 首装引导页 `onboarding/`

### 2.1 打开时机：`background/install.js`

```js
export function openOnboardingOnInstall(details) {
  if (!details || details.reason !== 'install') return;
  return chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/onboarding.html') });
}
```

- `background.js` 的 `onInstalled` 改为接收 `details`，原有三步照做，再调用这个函数。
- 开标签页失败（极少见）就让它 reject，由 `onInstalled` 回调里的 `.catch` 打一次日志（`console.error` 带操作名）。不吞掉。
- 单独成文件，是为了在 node 里用假 `chrome` 做单测，不必加载整个 `background.js`。

### 2.2 页面骨架

- 三个文件：`onboarding.html`、`onboarding.js`、`onboarding.css`，各自控制在 400 行以内。
- i18n 和主题照搬 `pdf/upload.html` 的做法：
  - 加载 10 个 `../i18n/lang/*.js` 和 `../i18n/messages.js`；
  - `[data-i18n]` 写 textContent；
  - 启动时读 `{uiLanguage, theme}`，设置 `data-theme`；
  - 亮暗两套调色板都写在 `:root` 变量里。
- 脚本加载顺序和设置页相同。引擎族依赖 `lang-tags`，端上状态依赖 `engine-status`，后者又依赖 `api-compat`：
  ```
  shared/api-compat.js → shared/default-settings.js → shared/engine-status.js
  → shared/lang-tags.js → shared/target-lang.js → i18n ×11
  → shared/tab-broadcast.js → shared/language-pack.js
  → content/engine/languages.js → content/engine/watchdog.js → content/content-translation-engine.js
  → onboarding.js
  ```
  `test/unit/engine-status.test.mjs` 的两条加载顺序测试把 `onboarding/onboarding.html` 加进被检查的清单。

### 2.3 四块内容

1. **端上翻译**（`#builtinSection`）
   - 状态文字取自 `LanguagePack.describe()`（§3）。
     - 不支持时说出原因，文案键来自 `EngineStatus.REASON_MESSAGE_KEYS`；
     - 支持时显示 en→目标语言的语言包状态，和设置页同一句话。
   - 「下载语言包」按钮只在状态是 `downloadable` 时出现。点击后在这次点击里直接调用 `LanguagePack.download()`，因为 user activation 必须由这次点击产生。
   - 目标语言一变，状态重算。
2. **目标语言**（`#targetLang`）
   - `<select>` 的选项来自 `TargetLang.options(uiLang)`。
   - 默认值是 `TargetLang.effective(settings)`：没选过就显示跟随浏览器的那门，不显示空。
   - 改动后写 sync `targetLang`（写入的是具体的码）。
3. **翻译引擎**（`#engineSection`）
   - 两个 radio：「端上（推荐）」和「配置 AI」。初值按 `translationEngine` 定。
   - 选「端上」：写 `translationEngine:'builtin'`。
   - 选「配置 AI」：下面展开三个按钮 `#aiOllama`、`#aiLmStudio`、`#aiCloud`。
     - Ollama 和 LM Studio 两个按钮写入：`translationEngine:'ai'`；`provider`；`apiEndpoint` 取自 `APICompat.PROVIDERS[p].endpoint`；`modelName` 取自 `PROVIDERS[p].defaultModel`。
     - 云端按钮只写 `translationEngine:'ai'`，provider 让用户到设置页去挑。
     - 三个按钮写完之后，都新开一个标签页到 `options/options.html#apiSettingsCard`。
   - 连接表单不抄。设置页 API 卡片（`options.html:92`）加上 `id="apiSettingsCard"`，靠浏览器原生锚点定位。
4. **快捷键**（`#shortcutList`）
   - 列表来自 `chrome.commands.getAll()`，跳过 `_` 开头的内置命令。
   - 命令名对应的标签复用现有文案键：`toggle-translate-page` 用 `translatePage`，`toggle-translation-only` 用 `showTranslationOnly`。认不出的命令退回 Chrome 给的 description。
   - 键位为空时显示 `onboardingShortcutNotSet`（「未设置」）。列表下方有一句纯文字提示，说明可以到 `chrome://extensions/shortcuts` 改。这里不做链接，因为扩展页面打不开 `chrome://` 链接。

所有写入都走 `chrome.storage.sync.set(patch)`，然后调用 `TabBroadcast.settingsUpdated(patch)`。只广播改动的那几个键，内容脚本做的是 `Object.assign`。

### 2.4 页面底部

- 两个按钮：「打开完整设置」（`chrome.runtime.openOptionsPage()`）和「完成」（`window.close()`）。
- 引导页里的每一项改动都是即写即存，所以没有「保存」按钮。

## 3. 抽出来的两个共享模块

### 3.1 `shared/language-pack.js` → `root.LanguagePack`

```js
PROBE_SOURCE = 'en'
describe(engine, { targetLang, engineFallback })
  // → { key, lang?, downloadable:false } 已知答案（不支持 / 仅 AI / 目标是英语）
  // → null 要问 availability()
probe(engine, targetLang)          // async → { key, downloadable }
message(result, t, uiLang)         // → 可显示的句子（替换 {lang}）
download(engine, targetLang, onPercent)
  // → ensureDownloaded；成功后 TabBroadcast.languagePackReady(apiLang)
  // 失败向上抛，由页面决定怎么显示
```

- `options-builtin.js` 改为调用这四个函数。`seq` 丢弃过期结果的逻辑，以及「检查中…」的中间态，仍留在页面这一侧，两页各自持有。
- `options.js` 删掉 `broadcastLanguagePackReady` 和 `BUILTIN_PROBE_SOURCE`，不留旧名字。

### 3.2 `shared/tab-broadcast.js` → `root.TabBroadcast`

```js
settingsUpdated(settings)      // 每个标签页发 SETTINGS_UPDATED
languagePackReady(targetLang)  // 每个标签页发 LANGUAGE_PACK_READY（sourceLang = 'en'）
```

- 没有 content script 的标签页会 reject。这是「广播」这种附带动作可以失败的情形，逐个 `.catch(() => {})`，和原实现一致。
- `options.js` 的 `notifyContentScripts` 删掉，三处调用直接改为 `TabBroadcast.settingsUpdated`。

## 4. 设置导入导出

### 4.1 文件格式

```json
{
  "format": "blab-settings",
  "version": 1,
  "exportedAt": "2026-09-25T08:00:00.000Z",
  "settings": { "targetLang": "ja", "...": "..." },
  "siteRules": { "example.com": "always" }
}
```

- 文件名 `blab-settings-YYYYMMDD.json`（本地日期），用 `Blob` + `<a download>` 下载。
- 顶层除 `format` / `version` / `exportedAt` 外，每个键是一个 **section**。

### 4.2 `settings` 里放什么

- 取值范围是设置页 `defaultSettings`（`options/options.js:133-195`）∪ `CONTENT_DEFAULTS`（`shared/default-settings.js`）。
- 具体的值来自 `chrome.storage.sync`，而不是表单，这样没画在界面上的键也能带上。
- 以下这些不导出：

| 键 / 数据 | 不导出的理由 |
|---|---|
| `apiKey` | 凭证。只有勾选「包含 API Key」时才带上，默认不勾 |
| `siteRules` | 它有自己的 section，不重复出现在 settings 里 |
| `siteAskCount` | 本机追问次数，不是用户的选择；带到别的机器上意义不同 |
| `youtubeCaptionPosXPct` / `PosYPct` / `WidthPct` / `Scale` | 拖拽出来的设备几何，换一台屏幕就不对了 |
| `chrome.storage.local` 全部 | 本机缓存、统计、登录态、任务列表都在这里，都不属于「设置」 |
| 其他不在两份默认值里的 sync 键 | 未知键，不认识的东西不往外带 |

### 4.3 section 表（`options/options-transfer.js`）

```js
const TRANSFER_SECTIONS = [
  { key: 'settings',  collect, validate, preview, apply },
  { key: 'siteRules', collect, validate, preview, apply },
];
```

- 表头注释写明两个后续 section：
  - P1-B 会加 `customRules`：值是 `CustomRules.toExportFile()` 对象，通过 `CustomRules.request('import', { file })` 应用；
  - P1-C 会加 `glossary`：值是一个 CSV 字符串。
  
  两者本次都不实现。（P1 协调 2026-09-25）
- **section 的值不一定是对象。** `validate(raw)`、`apply(value)` 和预览都不假设值的形状，每个 section 自己决定怎么画预览行。（P1 协调 2026-09-25）
- 编排逻辑放在纯函数模块 `shared/settings-transfer.js`，node 可以直接测：
  - `parseFile(text)`：
    - 不是 JSON，抛 `notJson`；
    - 不是对象、或 `format` 不对，抛 `wrongFormat`；
    - `version !== 1`，抛 `wrongVersion`。
  - `validateAll(file, sections)`：
    - **先把所有 section 全部校验完**，任何一个抛错，整份拒绝。
    - 所有 section 加起来一条都没接受，也整份拒绝，报 `nothingValid`。
    - 文件里不认识的 section 按名字列进 `unknown`，由预览显示「此版本不认识，将忽略」，不静默丢弃。（P1 协调 2026-09-25）
  - `applyAll(validated, sections)`：
    - 按表的固定顺序逐个 `apply`，遇到第一个失败就停。
    - 抛出的 `TransferApplyError` 带 `written[]`（已写入的 section）和 `failed`（失败的那个）。
    - 不回滚，也不吞错；页面据此告诉用户哪几块写进去了、哪一块失败。（P1 协调 2026-09-25）

### 4.4 `settings` section 的校验

对每个键，按下面五条逐一判定。不合格的键被丢弃并计数，丢弃的键名进预览：

1. 键必须在上面的范围内，并且不在排除表里。`apiKey` 例外：导入端接受它，因为用户导出时是明确勾选了的。
2. 值的类型必须和默认值相同。数字还要求 `Number.isFinite`。
3. 枚举键的值必须合法，枚举表 `ENUMS` 见下文。
4. `targetLang` 必须是 `TargetLang.SUPPORTED` 里的码，或者是 `''`。`comicTargetLang` / `pdfTargetLang` 必须在 `CLOUD_TARGETS` 里，或者是 `''`。
5. 全部校验完之后，把合格的键合进当前设置，用 `hasHotkeyConflict(merged)` 检查热键冲突。有冲突就**整份拒绝**，报 `hotkeyConflict`。

`ENUMS` 在运行时按共享模块现算，不在第二处写死：

| 键 | 合法值 |
|---|---|
| `translationEngine`、`autoTranslateEngine` | `builtin` `ai` |
| `engineFallback` | `local-only` `allow-ai` |
| `provider` | `Object.keys(APICompat.PROVIDERS)` |
| `selectionTranslationMode` | `inline` `popup` |
| `selectionTranslationHotkey`、`hoverTranslationHotkey` | `Shift` `Alt` `Control` `Meta` |
| `translationStyle` | `TranslationDisplay.STYLES` |
| `captionDisplayMode` | `''` `bilingual` `translation` `original` |
| `captionTranslationPosition` | `below` `above` |
| `ocrEngine` | `local` `vision` |
| `theme` | `light` `dark` |
| `uiLanguage` | `''` + `UI_LANGUAGES` |

- 有一条单测把这张表和 `options.html` 里对应 `<select>` 的 `<option value>` 逐一比对，防止两边漂移。
- **写入。**
  - 只做一次 `chrome.storage.sync.set(clean)`。
  - `enableComic` / `enablePdf` 照文件写入，不走设置页上的登录门。门是开关交互时的提示，导入是用户自己带来的状态。
  - 写完调用 `loadSettings()` 重画表单，再调用 `TabBroadcast.settingsUpdated(collectSettings())`。
- **预览**显示三项：会变的键数、丢弃的键数、会变的键名清单。

#### AI 路径提示（P1 协调 2026-09-25）

- 如果导入会打开一条目前关着的无人值守 AI 路径，预览里显示 `autoTranslateEngineAiConfirm` 那句话。这三条路径是：
  - 自动模式引擎为 AI；
  - 手动引擎为 AI；
  - 回退为 `allow-ai`。
- 判断方式：`options/options-auto.js` 的 `unattendedAiReachable()` 改成接收一个 settings 对象。现有调用方传入 `collectSettings()`。预览分别对当前设置和合并后的设置各调用一次，条件是 `!reach(current) && reach(merged)`。
- 三条路径的判断只有这一份，不写第二遍。
- 用户点「确认导入」即视为同意，不再弹 `confirm`。

### 4.5 `siteRules` section

- **校验。**
  - 值必须是普通对象。
  - 每条规则的值只接受 `always` / `never`。
  - 键先经过 `SiteRules.normalizeHost`，归一化结果为空的丢弃。
- **预览**显示接受的规则条数和丢弃的条数。
- **写入。**
  - 调用 `SiteRules.importUserRules(map)`，也就是 `request('import', { map })`，由服务工作者排队执行 `applyImportedRules({ map })`：
    1. 读出现有表；
    2. 逐条 `normalizeHost`，只收 `always` / `never`；
    3. 与现有表合并，导入的条目覆盖同名键；
    4. `compactUserRules`；
    5. 仍超过 `MAX_ITEM_BYTES` 就**抛错**；
    6. 做**一次** `set`。
  - `shared/site-rules.js` 的改动**只追加**：新函数 `applyImportedRules`；`WRITES` 表末尾加 `import: applyImportedRules`；新函数 `importUserRules`；导出对象里加上它。
  - `applyWrite`、`request`、`enqueue` 的函数体一行不动。P1-B 会把这三个挪到 `shared/storage-writer.js`。（P1 协调 2026-09-25）

### 4.6 卡片 UI（`options.html`，放在高级设置卡片之后）

- 「导出」按钮。
- 「包含 API Key」复选框，默认不勾，旁边一句话说明风险。
- 「导入」按钮，背后是一个 `<input type="file" accept=".json,application/json" hidden>`。
- 预览区 `#transferPreview`：
  - 各 section 的摘要行；
  - 不认识的 section；
  - AI 提示；
  - 「确认导入」和「取消」两个按钮。
- 失败信息写在卡片内的 `#transferError`，用 `role="alert"`。成功信息走现有的 `showStatus`。
- 坏文件、全部不合格的文件、写入失败，都不会改动任何一个字节（写入失败时，已写的 section 会按 §4.3 如实列出）。

## 5. i18n

- 新键按块追加到 10 个 `i18n/lang/*.js` 的末尾，`transfer*` 一块，`onboarding*` 一块。每种语言都写完整句子，不做拼接。
- `_locales` 不动：引导页不改 manifest，也没有新的 manifest 文案。

## 6. 打包

- `package.json` 的 `zip` 脚本加上 `onboarding/`。
- 单测照 `api-compat.test.mjs:180` 的写法断言 `/\bonboarding\/\s/`。

## 7. 文档与杂项

- 仓库地址改三处（§1.4）。
- 分批数字改三处（§1.4）。
- README 中英各加两节：
  - 「首次安装引导」；
  - 「导入 / 导出设置」。
  
  内容对照真实 DOM 的按钮名写。
- CHANGELOG `## Unreleased` 下加 `### Onboarding page and settings import/export (P0-F)`。
- 不改版本号，不加 LICENSE。

## 8. 文件清单（P0 = 本批可改；P1 = P1 会话的地盘，只做 §4.5 的追加）

| 文件 | 归属 | 改动 |
|---|---|---|
| `onboarding/onboarding.html` / `.js` / `.css` | P0 | 新建 |
| `background/install.js` | P0 | 新建 |
| `background/background.js` | P0 | `onInstalled` 接收 `details`，调用 install.js |
| `shared/language-pack.js` | P0 | 新建（抽自 options-builtin） |
| `shared/tab-broadcast.js` | P0 | 新建（抽自 options.js） |
| `shared/settings-transfer.js` | P0 | 新建（纯函数） |
| `options/options-transfer.js` | P0 | 新建（DOM 与 section 表） |
| `options/options-builtin.js` | P0 | 改为调用 LanguagePack |
| `options/options.js` | P0 | 删两个广播函数，改调 TabBroadcast，接上导入导出的事件 |
| `options/options-auto.js` | P0 | `unattendedAiReachable(settings)` |
| `options/options.html` | 共享 | 加锚点 id、导入导出卡片、新脚本，改仓库地址 |
| `options/css/*.css` | 共享 | 导入导出卡片的样式（新文件 `transfer.css`） |
| `shared/site-rules.js` | **P1** | 只追加（§4.5） |
| `i18n/lang/*.js` ×10 | 共享 | 末尾追加两块 |
| `package.json` | P0 | zip 加 `onboarding/` |
| `README.md` / `CHANGELOG.md` / `CLAUDE.md` | 共享 | §7 |
| `test/e2e/fixtures.js` | P0 | 默认关掉首装引导标签页（§10.2） |

不动的文件：`manifest.json`（不加 commands、不改 content_scripts）、`_locales`、collect.js、api-client.js、ai-translate.js、prompts.js、batch.js、input-chip / dialog。

## 9. 错误处理

- 引导页的每次写入都 `await`。失败时在页面底部的 `#onboardingError` 显示 `onboardingSaveFailed`，同时 `console.error` 打一次，带操作名。
- 语言包下载失败时，状态行显示 `builtinDownloadFailed`，并打一次日志。
- 导入导出只在卡片这一层接住错误：显示错误，打一次日志，日志不带文件内容。

## 10. 测试

### 10.1 单测

- `test/unit/settings-transfer.test.mjs`
  - `parseFile` 三类错误；
  - `pickExport` 默认不带 apiKey，勾选后带上，排除表里的键一个不出；
  - `validateSettings`：类型错、枚举错、targetLang 不认识、未知键都会被丢弃并计数；
  - `validateAll`：先全校验、`unknown` 列表、`nothingValid`、section 值为字符串时不崩；
  - `applyAll`：顺序固定，遇到第一个失败就停，`written` 正确；
  - `ENUMS` 与 `options.html` 的 `<select>` 一致（防漂移）。
- `test/unit/site-rules.test.mjs` 追加 `applyImportedRules`：
  - 归一化、只收 `always` / `never`、合并覆盖、只 `set` 一次、超预算时抛错且不写；
  - `importUserRules` 走 `import` 这个 kind。
- `test/unit/install.test.mjs`：`install` 开标签页，`update` 和 `chrome_update` 不开。
- `test/unit/language-pack.test.mjs`：`describe` 的四种静态答案、`probe` 的状态映射、`message` 替换 `{lang}`。
- `test/unit/engine-status.test.mjs`：加载顺序清单加上 `onboarding/onboarding.html`。
- `test/unit/api-compat.test.mjs`：zip 包含 `onboarding/`。

### 10.2 e2e 旅程（验收单元）

通用规则：

- **几何断言。** 每条旅程都对关键元素断言以下四点：
  - 可见；
  - 包围盒完全在视口内（1280×720）；
  - 与相邻的关键元素互不重叠；
  - 暗色主题下，关键文字与背景的对比度 ≥ 4.5（前景色和背景色都用 `getComputedStyle` 取）。
- **fixture 行为。** 每个 context 都是一次全新安装，所以都会弹出引导页。
  - fixture 默认等它出现后关掉（先保证有别的页面，避免关掉最后一个标签页）。
  - 需要它的测试用 `test.use({ keepOnboarding: true })`。

| 旅程 | 内容与断言 |
|---|---|
| J-F1 首装开页 | `keepOnboarding`：context 起来后出现 `onboarding/onboarding.html` 标签页。四块区域全部可见、在视口内、互不重叠。标题文字对比度（暗色）达标。 |
| J-F2 选语言 | 在引导页选 `ja`：sync `targetLang === 'ja'`。下拉框可见、在视口内。 |
| J-F3 端上状态 | `addInitScript` 打桩 `Translator`（同 J-B2），`availability` 返回 `downloadable`：状态行显示可下载那句话，下载按钮可见、在视口内、不与状态行重叠。点击按钮后，桩里的 `create` 被调用，状态变为就绪。 |
| J-F4 AI 本机 | 选「配置 AI」→「Ollama」：sync 中 `translationEngine==='ai'`，provider 与 endpoint 等于 PROVIDERS 预设。新标签页 URL 以 `#apiSettingsCard` 结尾，`#apiSettingsCard` 在视口内。 |
| J-F5 导出 | 设置页导出：下载文件中没有 `apiKey`，且 `format` / `version` 正确。勾选「包含 API Key」再导出：文件带上 `apiKey`。卡片按钮可见、在视口内、互不重叠。 |
| J-F6 预览→合并 | 先写入 `translationEngine`、`autoTranslateEngine` 为 builtin，`engineFallback` 为 local-only。导入一份把 `autoTranslateEngine` 改成 `ai`、并把 `showFloatBall` 设为 false 的文件：预览列出会变的键，AI 提示出现。另导入一份不改引擎的文件：AI 提示不出现。确认导入后，sync 已合并，内容页的悬浮球消失（`SETTINGS_UPDATED` 已送达）。预览区在视口内，按钮不重叠。 |
| J-F7 站点规则往返 | 写入两条规则，导出，清空，再导入：sync `siteRules` 恢复原状，设置页的站点规则表画出两行。 |
| J-F8 坏文件 | 分别导入非 JSON、`format` 错误、全部键都不合格的文件：`#transferError` 显示对应的错误，并且在视口内。导入前后 sync 全量快照完全一致。 |

## 11. 文档

- README 中英两份、CHANGELOG、CLAUDE.md，见 §7。
- 本设计文档在 §15 登记实现偏差。

## 12. 接缝

- **P1-B**：`shared/storage-writer.js` 会接管 `applyWrite` / `request` / `enqueue`。本批只在 `WRITES` 表加一行、在导出对象加一个名字，迁移时照搬即可。`TRANSFER_SECTIONS` 预留 `customRules`。
- **P1-C**：`TRANSFER_SECTIONS` 预留 `glossary`（值是 CSV 字符串），编排逻辑不假设值是对象。
- **设置页**：`options-sync-mirror.js` 会把别处（引导页）写进 sync 的值映射回表单，所以引导页和设置页同时开着也不会冲突。

## 13. 遗留项

- 引导页不做「重新打开引导」的入口。设置页的完整功能已经覆盖引导页全部四块。
- 快捷键不能在扩展内修改，只能提示去 `chrome://extensions/shortcuts`。

## 14. 决策登记（台账 D-306，待主控确认）

1. 首装引导只在 `reason === 'install'` 时打开。
2. 引导页选 AI 后送到设置页的连接卡片，不复制连接表单。
3. 导出文件格式 `blab-settings` v1。API Key 默认不导出。设备几何、追问计数和 local 存储一律不导出。
4. 导入流程：先全部校验，再按固定顺序应用，遇到第一个失败就停，不回滚、不吞错，如实告诉用户。不认识的 section 列出名字后忽略。
5. 导入如果会打开无人值守的 AI 路径，在预览中给出提示；用户确认导入即视为同意。

## 15. 实现偏差（实现时登记）

（实现完成后补）
