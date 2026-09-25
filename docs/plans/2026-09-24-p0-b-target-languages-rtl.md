# P0-B 目标语言扩到 76 门 + 右到左排版 — 设计

- 基线：`a7ef73e`（叠在 #106 P0-C 之上）。行号都按这个基线写。
- 台账：D-304。
- 验收单位：带几何断言的 e2e 旅程（§10.2）。

## 0. 结论

1. **目标语言从 10 门扩到 76 门。**
   - 清单取 Chrome 自己的界面语言（§2），它包含端上 Translator 能译的全部 39 门。
   - 另外 37 门只有 AI 引擎能译，界面上标成「仅 AI」。
2. **全扩展只留一份清单**，就是 `shared/target-lang.js` 的 `SUPPORTED`。
   - 语言名不再写死，由 `Intl.DisplayNames` 按界面语言现算。
   - 名字有两种形态：菜单形（句首大写）和句中形（Intl 原样）。
   - 散在六处的旧清单和 11 个 `lang*` 文案键全部删除（§4）。
3. **端上译不了的语言，失败要看得见。** 分三处：
   - 设置页点名提示。按 `engineFallback` 分两种说法，并隐藏「下载语言包」按钮。
   - 语言菜单上给这类语言标「仅 AI」。
   - 运行时报错时说出语言名（§5）。
4. **译文节点一律带 `lang` 和 `dir`。** LTR 也显式写上。加载态按界面语言打标。
5. **右到左排版。**
   - 原文与译文方向相反时，译文对齐一律取 `start`。居中和两端对齐照抄原文。
   - 文字缩进和水平导航的 4px 间隙，都放在原文的起始边（§7）。
6. **朗读。** 本机有声音、但没有这门语言的声音时，按钮进入「无声音」态，不再静默失败（§8）。
7. **漫画和 PDF 云端仍是原来的 10 门。** 名字改用 Intl，「跟随」照旧透传（§4.5）。

### 兼容影响（已发布客户端的存储契约）

- **存储值不变。**
  - `targetLang` 仍存码，`zh-CN`、`zh-TW` 两个值不动。
  - 身份戳 `''` 仍表示「跟随浏览器」。
  - 旧版本存下的 10 个码都还在新清单里，老用户显式选过的语言原样生效。
- **会变的是 `targetLang === ''`（跟随浏览器）的用户。**
  - 以前浏览器语言不在那 10 门里，一律收成 `en`。
  - 现在浏览器语言属于新增的 66 门时，会真的跟随那门语言。例如瑞典语浏览器以前拿到英文译文，现在拿到瑞典语。
- **其中 37 门是「仅 AI」语言。** 在默认配置（`translationEngine: 'builtin'` + `engineFallback: 'local-only'`）下：
  - 这些用户会从「拿到英文译文」变成「收到点名报错」。
  - 报错会告诉他们换 AI 引擎、允许回退或改选目标语言。
  - 这是「跟随浏览器」这句话本来的意思。以前收成英文，是清单太短造成的，不是设计。
  - 我们不为此做任何兼容或静默兜底，只把失败说清楚。
- **不会串味。** 译文缓存按请求语言分键（`batch.js:289-293` 的 `request`），跟随语义变了，旧缓存也不会被当成新语言的译文。
- **输入框旁的「译成 X」芯片（`content-input-chip.js:120-131`）会在更多页面出现。**
  - 这颗芯片把用户输入译成**页面语言**。以前页面语言认不出（例如瑞典语）就收成 `en`，核对不上，芯片不出；现在瑞典语页面会出「译成瑞典语」。
  - 这是预期内的放宽：判断它的仍是 `isSameLanguage`，只是认得出的语言多了。

## 1. 现状（file:line，基线 a7ef73e）

### 1.1 目标语言清单散在六处，全部写死

| # | 位置 | 内容 |
| --- | --- | --- |
| 1 | `shared/target-lang.js:33` | `SUPPORTED`，10 个码。`:37-48` 是 `VARIANTS` 地区变体表 |
| 2 | `content/content-bootstrap.js:16-28` | `TARGET_LANGUAGE_OPTIONS`，10 项，标签是写死的本名 |
| 3 | `background/settings.js:16-27` | `languageNames`，值是本名。唯一使用方是 `ai-translate.js:11/:90/:123/:175/:218`（`languageNames[targetLang] \|\| targetLang`，拼进提示词） |
| 4 | `options/options.html` | `#targetLang :333-342`、`#uiLanguage :350-359`、`#comicTargetLang :672-681`、`#pdfTargetLang :704-713`、自动翻译源语言芯片 `:233-241`，全是 `data-i18n="lang*"` |
| 5 | `i18n/lang/*.js` | 11 个 `lang*` 键（`en.js:225-235`）。10 个文件里的值一模一样，都是本名，其实不是翻译 |
| 6 | `shared/ocr.js` | `:205-211` `OCR_LANGUAGES[].labelKey`（死字段）、`:601-615` `DETECTED_LANGUAGE_LABEL_KEYS`、`:617-620` `detectedLanguageLabelKey`。另有 `options/options-pdf-tasks.js:22-24` 的 `PDF_TASK_LANG_KEYS` |

**不属于这份清单、保持不动的：**
- `engine/languages.js:45` 的 `SUPPORTED_LANGS`（39 门）。它是端上 Translator 的**能力**清单，不是目标语言清单。
- `LANG_ALIASES`（zh 系、`nb`/`nn`→`no`、`iw`→`he`、`in`→`id`）。

`test/unit/target-languages.test.mjs` 现在的工作是把前四处互相对照。这正说明清单写了四遍。

### 1.2 译文没有 `lang` / `dir`，排版只认左边

- **没有任何插入点打标。**
  - 页面译文：`insert.js:191` `finishTranslationInsert`、`:348` `insertTranslationBlock`。
  - 悬停：`hover/render.js:57/:81/:103/:144/:178/:211`。
  - 划词行内：`hover/selection.js:129/:180`。
  - 字幕：`captions/overlay.js:28/:54`。
  - 结果：阿拉伯语译文会继承英文页面的 `ltr`，标点和数字的双向排序全错，屏幕阅读器也会用英语读。
- **对齐照抄原文。**
  - 位置：`insert.js:404`（`text-align: ${computedStyle.textAlign}`）和 `hover/render.js:28`。
  - 英文段落算出来是 `start`。复制给 `dir=rtl` 的译文后，它自己的 `start` 在右边，这一条碰巧是对的。
  - 但原文是 `left` 时（很多站点写死 `text-align:left`），阿拉伯语译文会被压在左边。
- **缩进只写 `padding-left`。**
  - `collect.js:763-810` `getTextOffsetLeft` 只量「文字左边离盒子左边多远」。
  - 三个调用方都写 `padding-left`：`insert.js:509-514`、`hover/render.js:95-100/:203-208`。
  - 在 RTL 原文页上，图标在右边，这个量是错的。
- **水平导航的间隙也只写左边。**
  - `.ai-translator-inline-right { margin-left: 4px !important }`（`content/css/translation.css:239`）。
  - 在 RTL 导航里，译文跟在原文左侧，间隙却开在它的左外侧。

### 1.3 端上译不了的目标语言：只有通用说法

- **引擎层。** `content-translation-engine.js:302-309` 抛 `UNSUPPORTED_PAIR`。
  - `:498-510` `engineErrorMessage(reason)` 只给通用的 `builtinUnsupportedPair`。
  - 用户看不出是「目标语言本身不行」还是「这一对不行」。
- **设置页。** `options/options-builtin.js:23-73` 只能靠 `availability()` 得知。
  - `:69` 的 default 分支同样是通用说法。
  - 此时下载按钮的状态也没有被明确处理。
- **已有保证。** `popup-status.spec.js:115` 起的用例用 `af` 证明了 local-only 下一分钱都不花。这一条行为不变。

## 2. 76 门清单与理由

### 2.1 来源和合并规则

- **来源**：Chromium `build/config/locales.gni` 的界面语言，共 82 个 locale（crawl-store 存档 id 1012）。
- **合并成一门的**：
  - `en-GB`/`en-US` → `en`
  - `es`/`es-419` → `es`
  - `fr`/`fr-CA` → `fr`
  - `pt-BR`/`pt-PT` → `pt`
  - `sr`/`sr-Latn` → `sr`
  - `zh-HK` → `zh-TW`
- **改名的**：`nb` → `no`，与 `engine/languages.js` 的别名表一致。
- 82 − 6 = **76**。

### 2.2 为什么是这份

1. **包含端上 39 门。** 生成器已核对：`SUPPORTED_LANGS` 的每一门经 `toApiLang` 后都在这 76 门里。
2. **名字齐全。** 每一门在 10 种界面语言下都有 `Intl.DisplayNames` 名字，也都有本名（capcheck：10 × 76 全部存在）。
3. **客观、可引用、有人维护。** 这是 Chrome 能显示界面的语言，也就是浏览器这群用户实际在用的语言。
4. **AI 引擎都能译。**

### 2.3 为什么不再多

- 再往外没有客观边界。
- 长尾语言在部分界面语言下，`DisplayNames` 取不到名字（`fallback: 'none'` 返回 `undefined`）。
- 书写方向和书写系统要逐门核对。
- 以后要追加，只需在 `SUPPORTED` 里加一个码。§10.1 的测试会自动覆盖名字、本名和方向。

### 2.4 `zh-CN` / `zh-TW` 不改名

- 这两个是已发布客户端存下的值，不能动。
- 查名字时经 `DISPLAY_TAG = { 'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant' }` 映射，得到「简体中文 / 繁體中文」这一对，而不是「中文（中国）/ 中文（台湾）」。

### 2.5 名字的两种形态

- **菜单形。** 用在选择器、菜单、标签这类独立出现的名字。
  - 规则：同时满足以下两条才把首字母大写。
    - 显示 locale 经 `maximize()` 后，书写系统属于 `CASED = {Latn, Cyrl, Grek, Armn}`；
    - 原始名字**全是小写**（`s === s.toLocaleLowerCase(locale)`）。
  - 例：fr 下 `persan` → `Persan`，`chinois simplifié` → `Chinois simplifié`；ru 下 `русский` → `Русский`。
  - 格鲁吉亚文（Geor）不在 `CASED` 里，`ქართული` 保持原样，不会变成 Mtavruli 大写字母。
  - 祖鲁语的本名 `isiZulu` 带内部大写，不是全小写，所以保持原样，不会变成 `IsiZulu`。
- **句中形。** 用来填进句子里的 `{lang}`，就是 Intl 的原样。
  - 10 种界面语言都正确：fr、es、pt、ru 小写（`en persan`），de 名词大写（`Persisch`），en 本来就大写。

下表由生成器 `langtable.mjs` 在 Node 25.5.0 上用 Intl 算出。实现以运行时 Intl 为准，这张表只是为了评审时看得见。

「内置」列打勾的 39 门是端上 Translator 能译的（`engine/languages.js` 的 `SUPPORTED_LANGS` 经 `toApiLang`）；其余 37 门「仅 AI」。「方向」列空白即 `ltr`。

| 码 | English | 简体中文 | 本名 | 书写系统 | 内置 | 方向 |
| --- | --- | --- | --- | --- | --- | --- |
| `af` | Afrikaans | 南非荷兰语 | Afrikaans | Latn |  |  |
| `am` | Amharic | 阿姆哈拉语 | አማርኛ | Ethi |  |  |
| `ar` | Arabic | 阿拉伯语 | العربية | Arab | ✓ | rtl |
| `as` | Assamese | 阿萨姆语 | অসমীয়া | Beng |  |  |
| `az` | Azerbaijani | 阿塞拜疆语 | Azərbaycan | Latn |  |  |
| `be` | Belarusian | 白俄罗斯语 | Беларуская | Cyrl |  |  |
| `bg` | Bulgarian | 保加利亚语 | Български | Cyrl | ✓ |  |
| `bn` | Bangla | 孟加拉语 | বাংলা | Beng | ✓ |  |
| `bs` | Bosnian | 波斯尼亚语 | Bosanski | Latn |  |  |
| `ca` | Catalan | 加泰罗尼亚语 | Català | Latn |  |  |
| `cs` | Czech | 捷克语 | Čeština | Latn | ✓ |  |
| `cy` | Welsh | 威尔士语 | Cymraeg | Latn |  |  |
| `da` | Danish | 丹麦语 | Dansk | Latn | ✓ |  |
| `de` | German | 德语 | Deutsch | Latn | ✓ |  |
| `el` | Greek | 希腊语 | Ελληνικά | Grek | ✓ |  |
| `en` | English | 英语 | English | Latn | ✓ |  |
| `es` | Spanish | 西班牙语 | Español | Latn | ✓ |  |
| `et` | Estonian | 爱沙尼亚语 | Eesti | Latn |  |  |
| `eu` | Basque | 巴斯克语 | Euskara | Latn |  |  |
| `fa` | Persian | 波斯语 | فارسی | Arab |  | rtl |
| `fi` | Finnish | 芬兰语 | Suomi | Latn | ✓ |  |
| `fil` | Filipino | 菲律宾语 | Filipino | Latn |  |  |
| `fr` | French | 法语 | Français | Latn | ✓ |  |
| `gl` | Galician | 加利西亚语 | Galego | Latn |  |  |
| `gu` | Gujarati | 古吉拉特语 | ગુજરાતી | Gujr |  |  |
| `he` | Hebrew | 希伯来语 | עברית | Hebr | ✓ | rtl |
| `hi` | Hindi | 印地语 | हिन्दी | Deva | ✓ |  |
| `hr` | Croatian | 克罗地亚语 | Hrvatski | Latn | ✓ |  |
| `hu` | Hungarian | 匈牙利语 | Magyar | Latn | ✓ |  |
| `hy` | Armenian | 亚美尼亚语 | Հայերեն | Armn |  |  |
| `id` | Indonesian | 印度尼西亚语 | Indonesia | Latn | ✓ |  |
| `is` | Icelandic | 冰岛语 | Íslenska | Latn |  |  |
| `it` | Italian | 意大利语 | Italiano | Latn | ✓ |  |
| `ja` | Japanese | 日语 | 日本語 | Jpan | ✓ |  |
| `ka` | Georgian | 格鲁吉亚语 | ქართული | Geor |  |  |
| `kk` | Kazakh | 哈萨克语 | Қазақ тілі | Cyrl |  |  |
| `km` | Khmer | 高棉语 | ខ្មែរ | Khmr |  |  |
| `kn` | Kannada | 卡纳达语 | ಕನ್ನಡ | Knda | ✓ |  |
| `ko` | Korean | 韩语 | 한국어 | Kore | ✓ |  |
| `ky` | Kyrgyz | 吉尔吉斯语 | Кыргызча | Cyrl |  |  |
| `lo` | Lao | 老挝语 | ລາວ | Laoo |  |  |
| `lt` | Lithuanian | 立陶宛语 | Lietuvių | Latn | ✓ |  |
| `lv` | Latvian | 拉脱维亚语 | Latviešu | Latn |  |  |
| `mk` | Macedonian | 马其顿语 | Македонски | Cyrl |  |  |
| `ml` | Malayalam | 马拉雅拉姆语 | മലയാളം | Mlym |  |  |
| `mn` | Mongolian | 蒙古语 | Монгол | Cyrl |  |  |
| `mr` | Marathi | 马拉地语 | मराठी | Deva | ✓ |  |
| `ms` | Malay | 马来语 | Melayu | Latn |  |  |
| `my` | Burmese | 缅甸语 | မြန်မာ | Mymr |  |  |
| `ne` | Nepali | 尼泊尔语 | नेपाली | Deva |  |  |
| `nl` | Dutch | 荷兰语 | Nederlands | Latn | ✓ |  |
| `no` | Norwegian | 挪威语 | Norsk | Latn | ✓ |  |
| `or` | Odia | 奥里亚语 | ଓଡ଼ିଆ | Orya |  |  |
| `pa` | Punjabi | 旁遮普语 | ਪੰਜਾਬੀ | Guru |  |  |
| `pl` | Polish | 波兰语 | Polski | Latn | ✓ |  |
| `pt` | Portuguese | 葡萄牙语 | Português | Latn | ✓ |  |
| `ro` | Romanian | 罗马尼亚语 | Română | Latn | ✓ |  |
| `ru` | Russian | 俄语 | Русский | Cyrl | ✓ |  |
| `si` | Sinhala | 僧伽罗语 | සිංහල | Sinh |  |  |
| `sk` | Slovak | 斯洛伐克语 | Slovenčina | Latn | ✓ |  |
| `sl` | Slovenian | 斯洛文尼亚语 | Slovenščina | Latn | ✓ |  |
| `sq` | Albanian | 阿尔巴尼亚语 | Shqip | Latn |  |  |
| `sr` | Serbian | 塞尔维亚语 | Српски | Cyrl |  |  |
| `sv` | Swedish | 瑞典语 | Svenska | Latn | ✓ |  |
| `sw` | Swahili | 斯瓦希里语 | Kiswahili | Latn |  |  |
| `ta` | Tamil | 泰米尔语 | தமிழ் | Taml | ✓ |  |
| `te` | Telugu | 泰卢固语 | తెలుగు | Telu | ✓ |  |
| `th` | Thai | 泰语 | ไทย | Thai | ✓ |  |
| `tr` | Turkish | 土耳其语 | Türkçe | Latn | ✓ |  |
| `uk` | Ukrainian | 乌克兰语 | Українська | Cyrl | ✓ |  |
| `ur` | Urdu | 乌尔都语 | اردو | Arab |  | rtl |
| `uz` | Uzbek | 乌兹别克语 | O‘zbek | Latn |  |  |
| `vi` | Vietnamese | 越南语 | Tiếng Việt | Latn | ✓ |  |
| `zh-CN` | Simplified Chinese | 简体中文 | 简体中文 | Hans | ✓ |  |
| `zh-TW` | Traditional Chinese | 繁体中文 | 繁體中文 | Hant | ✓ |  |
| `zu` | Zulu | 祖鲁语 | isiZulu | Latn |  |  |

## 3. API

### 3.1 `shared/target-lang.js`

```js
root.TargetLang = {
  SUPPORTED,        // 76 个码（§2），顺序无意义，展示时按界面语言排序
  CLOUD_TARGETS,    // 漫画/PDF 云端选择器用的 10 门，即旧 SUPPORTED
  fromTag(tag),     // 任意 BCP-47 标签 → SUPPORTED 里的一门；收不进就是 'en'
  browserLanguage(),
  effective(settings),                                 // 语义不变：存了就用存的，没存就跟浏览器
  nameOf(code, uiLang, { inSentence = false } = {}),   // §2.5
  autonym(code),    // 这门语言用它自己写的名字（菜单形）
  promptName(code), // 'Japanese (日本語)'；两者相同时只写一次：'English'
  direction(code),  // 'rtl' | 'ltr'
  options(uiLang, codes = SUPPORTED), // [{ value, label }]，label 为菜单形，按 Intl.Collator(uiLang) 排序
};
```

#### `fromTag` 的解析顺序（全程不用 try/catch）

1. 去掉首尾空白。空串返回 `'en'`。
2. **格式谓词。** 主语言 2–3 个字母，可选 4 字母书写系统，可选地区（2 个字母或 3 位数字），后面的变体和扩展忽略。
   - 建议写法：`/^([a-z]{2,3})(?:-([a-z]{4}))?(?:-([a-z]{2}|\d{3}))?(?=-|$)/i`。
   - 不匹配返回 `'en'`，例如 `x-klingon`、`i-default`。
   - 只把**匹配到的前缀**交给第 3 步。这样 `getCanonicalLocales` 不会因为残缺的扩展而抛错。
3. `Intl.getCanonicalLocales(prefix)[0]`。这一步会顺带处理旧码：`tl`→`fil`、`iw`→`he`、`in`→`id`、`sh`→`sr-Latn`、`mo`→`ro`，大小写也会规范化。
4. 在 `SUPPORTED` 里精确命中就返回。
5. 基码是 `zh` 时：`LangTags.getScriptVariant(tag) === 'hant' ? 'zh-TW' : 'zh-CN'`。沿用现有逻辑和注释。
6. `nb`、`nn` → `'no'`。`getCanonicalLocales` 不做这一步。
7. 基码在 `SUPPORTED` 里就返回基码，例如 `sv-SE`→`sv`、`pt-PT`→`pt`、`es-419`→`es`、`sr-Latn`→`sr`。
8. 以上都不命中，返回 `'en'`。这是现有契约，只用于「跟随浏览器」。

**删除 `VARIANTS`**：第 7 步已经覆盖了它。

#### `nameOf(code, uiLang, { inSentence })`

- 空串返回 `''`。
- 不满足格式谓词时**原样返回** `code`。例如 OCR 给出的怪码仍然看得见，不会变成空白。
- 用 `DISPLAY_TAG[code] || code` 查名。实例是 `new Intl.DisplayNames([uiLang], { type: 'language', fallback: 'none' })`，按 `uiLang` 缓存。
- 取不到名字（`undefined`）时原样返回 `code`。
- `inSentence` 为真时返回 Intl 原样，否则按 §2.5 处理成菜单形。
- 接受任何合法标签，不限于 `SUPPORTED`。OCR 探测到的 `zh-Hans`、`zh`、`ja` 都直接交给它。

#### 其余三个

- `autonym(code)` = `nameOf(code, DISPLAY_TAG[code] || code)`。例：`'zh-TW'` → `繁體中文`，`'zu'` → `isiZulu`。
- `promptName(code)`：
  - 规则：`${nameOf(code, 'en', { inSentence: true })} (${autonym(code)})`；两者相同时只写英文名。
  - 它替代 `settings.js` 的字面量表。
  - 模型拿到英文名，再加上本名作佐证。`zh-CN` 这种码本身就有歧义，不能只给码。
- `direction(code)`：`new Intl.Locale(DISPLAY_TAG[code] || code).maximize().script` 属于 `RTL_SCRIPTS = {Arab, Hebr, Thaa, Syrc, Nkoo, Adlm, Rohg}` 时返回 `'rtl'`，否则返回 `'ltr'`。
  - 不合法或空串返回 `'ltr'`，与 HTML 的缺省一致。
  - 76 门里是 RTL 的：`ar fa he ur`。
  - 不用 `getTextInfo()`，也不依赖 `:dir()`：最低支持 Chrome 116。

### 3.2 `content/content-language.js`（内容脚本）

| 名字 | 语义 |
| --- | --- |
| `ctx.languageName(code, opts)` | `TargetLang.nameOf(code, ctx.uiLanguage(), opts)` |
| `ctx.getTargetLangLabel(lang)` | 改为 `ctx.languageName(ctx.normalizeTargetLang(lang))`：界面语言下的**菜单形**。以前返回本名 |
| `ctx.normalizeTargetLang(lang)` | **保持原样**：`target-lang.test.mjs:101` 用正则钉住了它的函数体 |
| `ctx.buildTargetLangMenu(selected)` | 数据改用 `TargetLang.options(ctx.uiLanguage())`。**调用时**若 `ctx.builtinTranslator.isSelected(false)` 为真（手动引擎是内置），给「仅 AI」的项加 `data-tag="${t('langAiOnly')}"` |
| `ctx.markLanguage(el, code)` | `el.lang = code; el.dir = TargetLang.direction(code)`。LTR 也写，不依赖继承 |
| `ctx.startSide(style)` | `style.direction === 'rtl' ? 'right' : 'left'` |
| `ctx.translationTextAlign(sourceStyle, dir)` | §7.1 |
| `ctx.applyTextInset(translationEl, sourceEl, { fromContentBox })` | 用 `ctx.getTextInset` 量出 `px`。`px > 0` 时写 `padding-${ctx.startSide(getComputedStyle(sourceEl))}`，带 important |
| `ctx.revealSelectedLanguage(menu)` | §9 |

**「仅 AI」的判定**：`!bt.supportsLang(bt.toApiLang(code))`，其中 `bt = ctx.builtinTranslator`。这与引擎在 `content-translation-engine.js:302-309` 抛错时用的是同一个谓词。

**`data-tag` 必须用 CSS 画出来。** 规则是 `.ai-translator-lang-item[data-tag]::after { content: attr(data-tag) }`，不能写进 `textContent`。原因：
- `content-popup.js:392-396` 用 `item.textContent` 当选中后的标签，标记写进去就会被带走。
- 伪元素不进 `textContent`。这样 D 的文件一行都不用改。

### 3.3 `content/content-bootstrap.js`

- 导出 `ctx.uiLanguage()`，返回 `getUILanguage(ctx.settings.uiLanguage)`。
- `ctx.t`（现在在 `:59` 内部自己算）改为调用它，保证界面语言只有一个出处。

## 4. 名字迁移：删旧建新

### 4.1 删除

- `content-bootstrap.js:16-28` `TARGET_LANGUAGE_OPTIONS`，以及 `content-language.js:8` 对它的读取。
- `background/settings.js:16-27` 的字面量表，改为：
  `const languageNames = Object.fromEntries(TargetLang.SUPPORTED.map((c) => [c, TargetLang.promptName(c)]));`
  - `:102` 的导出不变，`ai-translate.js`（P1 的文件）一行不动。
  - `test/unit/api-key-rule.test.mjs:398-401` 的注释说 settings.js 因为这张表才不在 CJK 扫描范围内。表删了，要把 settings.js 加回扫描，并删掉那句注释。
- `options.html` 里写死的 `<option>` 和芯片标签。
  - `#targetLang` 全部删。
  - `#uiLanguage`、`#comicTargetLang`、`#pdfTargetLang` 只留第一项空值的「跟随」。
  - 芯片去掉 `data-i18n`，只留 `<span>`。
- 10 个语言文件里的 11 个 `lang*` 键（`langZh langZhCN langZhTW langEn langJa langKo langFr langDe langEs langPt langRu`）。
- `shared/ocr.js` 的 `labelKey` 字段、`DETECTED_LANGUAGE_LABEL_KEYS`、`detectedLanguageLabelKey` 及其导出（`:729`）。
- `options-pdf-tasks.js:22-24` 的 `PDF_TASK_LANG_KEYS`。

### 4.2 设置页：新文件 `options/options-languages.js`

- **放置顺序。** 在 `options.html` 里放在 `options-i18n.js`（`:886`）之后、`options.js`（`:896`）之前。依赖 `TargetLang`（`:850`）和 `getUILanguage`（i18n，`:856-866`）。
- **只导出一个** `renderLanguageOptions(uiLang)`，它画五处：

| 目标 | 画法 |
| --- | --- |
| `#targetLang` | `TargetLang.options(uiLang)`，76 项 |
| `#comicTargetLang`、`#pdfTargetLang` | 保留空值的「跟随」项，其后接 `TargetLang.options(uiLang, CLOUD_TARGETS)` |
| `#uiLanguage` | 保留空值的「跟随浏览器」项，其后按 `UI_LANGUAGES` 的顺序列 `autonym(code)`。界面语言选择器用本名，误切成看不懂的语言时也能找回来。这与旧的 `lang*` 值一致 |
| 自动翻译源语言芯片（9 个） | `span.textContent = TargetLang.nameOf(input.dataset.lang, uiLang)`。`zh` 显示为 Chinese / 中文 |

- **重画不能丢已选值。** 每个 select 先读出 `value`，重画后写回。
- **顺序陷阱。**
  - `options.js:232` 的 `elements.targetLang.value = targetLang` 执行时，option 必须已经存在，否则赋值会静默失败，select 停在空。
  - `applyI18n`（`options.js:284`）排在赋值之后，所以只挂在它上面来不及。
  - 做法：
    1. `loadSettings` 在 `:203` 之后、任何 select 赋值之前，用 `getUILanguage(result.uiLanguage)` 调一次 `renderLanguageOptions`；
    2. `options-i18n.js` 的 `applyI18n`（`:28-96`）末尾也调一次，保证切换界面语言时重画。
- **`#targetLang` 仍然没有「跟随」项**，行为不变：
  - `:203`/`:232` 显示有效值；
  - `:361` 只在用户动过之后才写回（`targetLangChosen`）。

### 4.3 内容脚本和 OCR

- **内容脚本。** 两处菜单（`content-popup.js` 的 D 部分、`content-input-dialog.js` 的 P1 部分）都经 `ctx.buildTargetLangMenu` 取数据，自动拿到 76 门、界面语言名和「仅 AI」标记，两个文件都不用改。
- **输入芯片。** `content-input-chip.js:114`（P1 的文件，**只改这一行**）改为：
  `t('inputChipTranslateTo').replace('{lang}', ctx.languageName(targetLang, { inSentence: true }))`
  - 原因：这是句子里的名字，fr 应该是 `Traduire en persan`，而不是 `Traduire en Persan`。
  - `:120-124` 注释里「十个选项」和「瑞典语页面」的例子随之过时（瑞典语现在认得出），改成清单外的语言（例如 `xh` 科萨语）。
- **OCR。** `content-image-ocr.js:40-51` 的 `sourceLabelFor` 改为：

  ```js
  if (!language) return '';
  return `${t('original')} · ${ctx.languageName(language)}`;
  ```

  - 同时更新注释里「Original · 日本語」的例子。
  - `zh` 显示为 Chinese / 中文（以前被强行算作简体）。
  - 不合法的码原样显示（`nameOf` 的规则）。
- **PDF 任务。** `options-pdf-tasks.js` 显示 `job.targetLang` 的地方改为 `TargetLang.nameOf(job.targetLang, currentUILang)`。

### 4.4 提示词里的语言名

- 使用 `promptName`：`Japanese (日本語)`、`Persian (فارسی)`、`English`。
- `prompts.js:79` 的 `{targetLang}` 替换（`buildPrompt`，`:77`）不变。
- `input-translation.spec.js:178-201` 的 `LANGUAGE_NAMES` 夹具断言的是本名出现在提示词里，本名仍在，所以不受影响。

### 4.5 云端（漫画 / PDF）

- **选择器只给 `CLOUD_TARGETS`（10 门）。** 名字改用 Intl，空值「跟随」保留。
- **「跟随」照旧透传。** 下面三处原样不动，发出去的是页面目标语言，可能是 76 门中的任何一门：
  - `context-menus.js:275`
  - `pdf-jobs.js:290`
  - `content-comic-translation.js:302-306`（`comicTargetLang()`）
- **为什么不在扩展里收窄：**
  - saas 侧 `TARGET_LANGS` 有 28 门（含 `nb`），接口也不校验 `targetLang`。云端能处理哪门语言，应该由云端回答。
  - 扩展里任何「收成最近一门」的做法都是静默兜底。
- 记入遗留项 §13-4，并列为用户待办。

## 5. 端上译不了时的提示

### 5.1 设置页（`options/options-builtin.js` `refreshBuiltinStatus`，`:23-73`）

在环境检查之后、`engine.availability()` 之前加一段**静态判定**：

```js
if (!engine.supportsLang(engine.toApiLang(targetLang))) {
  const key = settings.engineFallback === 'allow-ai'
    ? 'builtinTargetUnsupportedAllowAi'
    : 'builtinTargetUnsupportedLocalOnly';
  show(t(key).replace('{lang}', TargetLang.nameOf(targetLang, currentUILang, { inSentence: true })));
  hideDownloadButton();
  return;
}
```

- **为什么要静态判定。** `availability()` 对这类语言在不同 Chrome 上的答法并不一致；而且我们已经确定知道答案，不该让一次异步探测替我们说一句含糊话。
- **`engineFallback` 变化时也要刷新**，现在只在引擎和目标语言变化时刷新。
- **`:69` 的 default 分支保留通用的 `builtinUnsupportedPair`。** 那是「目标语言支持、但这一对不行」的真实情况，例如源语言问题。

### 5.2 语言菜单

- 手动引擎是内置时，「仅 AI」的项右侧用 `::after` 显示标记（§3.2）。
- 样式要求：
  - 放在 `popup.css` 已有的优先级带里，不用 `!important`；
  - 浅色主题在 `light-theme.css:23/:29` 附近补色；
  - 过 `host-css-containment.test.mjs`。

### 5.3 运行时报错

- **签名改动。** `content-translation-engine.js:498-510` 改为 `engineErrorMessage(reason, targetLang)`。
- **新分支。** `reason === UNSUPPORTED_PAIR` 且 `!eng.supportsLang(eng.toApiLang(targetLang))` 时，返回点名的 `builtinTargetUnsupportedLocalOnly`，填句中形。
  - 能走到 `:610` 的，都是**不能**回退 AI 的情况，所以只会用到 LocalOnly 那一句。
- **其他情况**仍返回 `builtinUnsupportedPair`。
- **调用点。** `:610` 把请求的目标语言传进来。

### 5.4 工具栏弹窗状态：不变

- `shared/engine-status.js` 对 `unavailable` 仍给通用的 `builtinUnsupportedPair`（`engine-status.test.mjs:125`）。
- 弹窗本身不选目标语言，这一处的改进记入 §13-7。

### 5.5 新增文案（10 种语言，完整句子，不拼接）

| 键 | en | zh-CN |
| --- | --- | --- |
| `builtinTargetUnsupportedLocalOnly` | Built-in translation can't translate into {lang}. Switch the engine to AI, or allow AI fallback, to use it. | 内置翻译无法译成{lang}。要用这门语言，请把引擎换成 AI，或允许回退到 AI。 |
| `builtinTargetUnsupportedAllowAi` | Built-in translation can't translate into {lang}, so these pages will go to your AI service. | 内置翻译无法译成{lang}，这类网页会交给你的 AI 服务翻译。 |
| `langAiOnly` | AI only | 仅 AI |
| `speechNoVoice` | No voice for this language on this device | 本机没有这门语言的朗读声音 |

- **占位符写法**：`t(key).replace('{lang}', name)`。
- **`{lang}` 一律填句中形。**
- **其余 8 种语言的句子结构**：`{lang}` 必须处在不需要变格、冠词或介词缩合的位置，例如同位语或冒号之后。
  - 反例：de 的 `ins {lang}` 会变成错误的 `ins Persisch`。
  - 正例：`Zielsprache {lang} …`。
- **顺带核对现有的 `inputChipTranslateTo`。** 10 种语言换成句中形后都要读得通，例如 ru `Перевести на персидский`、de `Auf Persisch übersetzen`。读不通的一并改句式。

## 6. `lang` / `dir` 打标

| 插入点 | 打标语言 |
| --- | --- |
| `insert.js:191` `finishTranslationInsert(element, translationEl, sourceWidthBefore, lang)` | 增加参数 `textLang`，调用 `ctx.markLanguage(translationEl, textLang)` |
| `insert.js:348` `insertTranslationBlock(block, translation, { lang, textLang })` | `textLang` 必传，缺了就抛错（程序错误，不兜底）。`lang` 仍是身份戳（`''` = 跟随） |
| `batch.js:347`（P1 的文件，**只改这一行**） | `{ lang: target.stamp, textLang: target.request }` |
| `hover/render.js` 加载态 `:57/:81/:103` | **界面语言**。里面是「翻译中…」这类界面文字 |
| `hover/render.js` 结果 `:144/:178/:211` | 请求的目标语言 |
| `hover/selection.js:129`（译文）、`:180`（加载态） | 同上两条 |
| `captions/overlay.js:28` 行、`:54` 译文 | 目标语言；原文行设 `dir="auto"` |
| `content-managed-translation.js:127-140` `putRule` 生成的 `::after` | 伪元素上设不了 `lang`。规则里加 `direction: …; unicode-bidi: isolate;`，再加 §7.1 的对齐。`lang` 的缺口记 §13-3 |

- `insertTranslationBlock` 的其他调用方，由实现时 `git grep` 查全，全部补上 `textLang`。
- 划词卡（D 的 `content-selection.js`）和 OCR 弹窗的打标，由**后合入的一方**补（§12）。

## 7. 右到左排版

### 7.1 对齐：`translationTextAlign(sourceStyle, dir)`

- **方向相同**（`sourceStyle.direction === dir`）：原样照抄 computed `textAlign`，与现在一致。
- **方向相反**：
  - `center`、`-webkit-center` → `center`
  - `justify` → `justify`
  - 其余一律 → `start`

理由：
- 原文靠起始边时，异向译文应该靠**它自己的**起始边。
- 原文靠结束边时（例如 LTR 页面里右对齐的数字列），那个物理位置恰好就是异向译文的起始边。
- 所以只要方向相反，除了居中和两端对齐，`start` 都是对的。
- 逻辑映射（`left`↔`right`）会把「英文页面写死的 `text-align:left`」翻成阿拉伯语的 `right`，结果对；但会把「右对齐的数字列」翻成 `left`，把阿拉伯语译文压到错的一边。

应用点：`insert.js:404`、`hover/render.js:28`。

### 7.2 缩进：按原文的起始边量，也写在起始边

- **`collect.js`（P1 的文件，就地修改，只动函数体和导出行）。**
  - `getTextOffsetLeft` 改名为 `getTextInset`，导出行 `:867` 同步改。
  - RTL 原文用 `originRight - rect.right` 量。
  - `fromContentBox` 时减去 `border-right` 和 `padding-right`。
  - LTR 分支保持现状。
- **`ctx.applyTextInset`**（§3.2，定义在 B 的 `content-language.js`）替换三个调用方的 `padding-left` 写法：
  - `insert.js:509-514`
  - `hover/render.js:95-100`
  - `hover/render.js:203-208`
- `translation-placement.test.mjs:58` 的正则同步改为钉住 `ctx.applyTextInset(…, block, { fromContentBox: placement.inside })`。
- 缩进写在**原文**的起始边：
  - 它表达的是「原文文字所在的带」，与译文的方向无关。
  - 例：英文页上带 24px 图标的行，阿拉伯语译文同样避开左侧那 24px。

### 7.3 水平导航的间隙

- `translation.css:239` 去掉 `margin-left: 4px !important`。
- 三个创建 `ai-translator-inline-right` 的地方，都按原文起始边写内联 `margin-${ctx.startSide(sourceStyle)}: 4px`，带 important：
  - `insert.js:414`
  - `hover/render.js:58`（加载态）
  - `hover/render.js:145`
- **为什么是起始边。** 行内译文跟在原文后面：
  - LTR 流里它在原文右侧，间隙开在它的左边；
  - RTL 流里它在原文左侧，间隙开在它的右边；
  - 两种情况都是「原文方向的起始边」。
- **引用 `inline-right` 的现有测试必须仍然通过**：`display-fixtures.js:8/:89`、`horizontal-nav.spec.js:33`、`translation-styles.spec.js:84/:191/:247/:277`。

### 7.4 语言菜单项

`popup.css:378` 的 `.ai-translator-lang-item` 把 `text-align: left` 改为 `start`。

### 7.5 已经正确、不用改的

- `translation.css:145/:175` 的引用样式已经用逻辑属性。
- `page/display.js` 的速览卡已处理 RTL。

## 8. 朗读

- **`shared/speech-lang.js`。**
  - `:38` 的 `SPEECH_REGION` 保留现有条目，`:34-36` 的注释（「选择器里的每门语言都要有一条」，并由 `content-speech.test.mjs` 对照 `content-bootstrap.js`）改为「只在地区确实需要选择时才加」。
  - 新增纯谓词 `hasVoiceFor(lang, voices)`：是否存在同基码的声音。
  - 比基码前两边都先规范化：`getCanonicalLocales` 加上 `nb`/`nn`→`no`（`iw`、`in`、`tl` 已由规范化处理）。否则挪威语的 `nb-NO` 声音会被误判为「没有」。
- **`content/content-speech.js`**（`applyButtonState :82`、`speakText :113`、`bindSpeakButton :168`）。
  - 声音列表**非空**、却没有同基码的声音时：
    - 按钮进入「无声音」态：加 class，`title` 和 `aria-label` 用 `speechNoVoice`；
    - `speakText` 返回 `false`，不再把文字交给一个会用错误语音乱读、或什么都不读的引擎。
  - 声音列表**为空**时（部分平台异步加载），维持旧行为。
  - `applyButtonState` 负责清掉这个状态。
- **只做单测验收（U-B10），不做 e2e。** 原因：
  - 声音列表因机器而异；
  - Playwright 的 `addInitScript` 只作用于主世界，打桩不到内容脚本所在的隔离世界里的 `speechSynthesis`。

## 9. 菜单滚动到已选项

- **问题。** 76 项、`max-height: 260px`（`popup.css:363`），打开菜单时已选项多半在视口外。
- **`ctx.revealSelectedLanguage(menu)`。**
  - 只设 `menu.scrollTop`，让 `.is-selected` 项落在可见区域中部。
  - **不用** `scrollIntoView`：它会连带滚动宿主页面。
- **调用点只有一处。** 划词卡和输入框对话框共用 `content-popup.js:355` 的 `setupLanguageDropdown`，菜单在它的 `openMenu`（`:376-380`）里打开。在那里加一行，两个面都覆盖。
  - 这是 D 的文件，由后合入的一方加（§12）。
- **B 负责**：函数本身及其单测。

## 10. 测试

### 10.1 单测

**重写 `target-languages.test.mjs`**，原来的四处互对已无意义（`:31`、`:49` 查找的东西都删了），改为以下断言：
- **清单**
  - `SUPPORTED` 有 76 个、不重复。
  - `SUPPORTED_LANGS`（39 门）每一门经 `toApiLang` 后都在 `SUPPORTED` 里。
  - `CLOUD_TARGETS` 是 `SUPPORTED` 的子集，并且等于旧的 10 门。
- **名字**
  - 每一门在 10 种界面语言下 `nameOf(code, ui) !== code`，并且 `autonym(code) !== code`。
  - `direction`：`ar fa he ur` 为 `rtl`，其余为 `ltr`。
- **`fromTag` 表驱动用例**

  | 输入 | 期望 |
  | --- | --- |
  | `sv-SE` | `sv` |
  | `tl` | `fil` |
  | `iw` | `he` |
  | `in` | `id` |
  | `nb`、`nn` | `no` |
  | `zh-HK`、`zh-Hant-TW` | `zh-TW` |
  | `zh` | `zh-CN` |
  | `sh` | `sr` |
  | `pt-PT` | `pt` |
  | `es-419` | `es` |
  | `EN-us` | `en` |
  | `xh` | `en` |
  | `x-klingon` | `en` |
  | `''` | `en` |
  | `en-US-u-` | `en`（残缺扩展不抛错） |

- **大写规则**
  - fr：`nameOf('fa','fr')` 为 `Persan`，句中形为 `persan`。
  - `autonym('ka')` 为 `ქართული`。
  - `autonym('zu')` 为 `isiZulu`。
  - `autonym('ru')` 为 `Русский`。
- **`promptName`**：`ja` → `Japanese (日本語)`，`en` → `English`。
- **`options`**：按 `Intl.Collator(ui)` 排序，每个 `label` 等于 `nameOf`。
- **设置页不再写死选项。** `options.html` 里 `#targetLang` 没有写死的 `<option>`；另外三个 select 只剩空值那一项。
- **`languageNames`**：键集合等于 `SUPPORTED`，值等于 `promptName`。

**新增或修改的其他单测**
- **i18n**
  - 4 个新键在 10 个文件里都存在，并且带 `{lang}` 的键在 10 个文件里都带 `{lang}`。
  - 11 个 `lang*` 键在 10 个文件里都已删除，全仓不再引用。
- **引擎**：`engineErrorMessage(UNSUPPORTED_PAIR, 'fa')` 返回点名句（句中形），`engineErrorMessage(UNSUPPORTED_PAIR, 'fr')` 返回通用句。
  - 放在单测里的原因：e2e 的 Chromium 可能没有 Translator，会先走 `UNSUPPORTED_ENV` 分支。
- **打标、对齐、缩进（纯函数）**
  - `markLanguage`、`startSide`。
  - `translationTextAlign` 全表：同向 × {left, right, start, end, center, justify}，异向 × 同一组。
  - `getTextInset` 的 RTL 分支，含 `fromContentBox`。
- **`revealSelectedLanguage`**：设置了 `scrollTop`，并且没有调用 `scrollIntoView`。
- **U-B10 朗读**：`hasVoiceFor` 的表驱动用例（含 `nb-NO` 对 `no`）；无声音态的进入和清除；声音列表为空时维持旧行为。

**需要改前提的现有单测**

| 文件 | 改动 |
| --- | --- |
| `content-speech.test.mjs:103-116` | 改为遍历 `SUPPORTED` 并使用合成的声音列表。`:96-101` 保留 |
| `ocr-core.test.mjs` | `:575-592` 改写为验证 OCR 码交给 `nameOf` 后的结果；`:810` 删除 |
| `input-chip.test.mjs:150-170`（P1 的文件） | 删除已失效的 `TARGET_LANGUAGE_OPTIONS` 桩；原先 `normalizeTargetLang('sv') === 'en'` 的断言改用 `xh` 断言回落到 `en`，另加一条 `sv` → `sv`。`:66-72` 的正则仍然成立 |
| `translation-placement.test.mjs:58` | 见 §7.2 |
| `api-key-rule.test.mjs:398-401` | 见 §4.1 |

**必须原样通过**
- `target-lang.test.mjs:85-103`
- `clip-guard.test.mjs:253-275`
- `engine-status.test.mjs:125`
- `block-identity.test.mjs:246-247`（若牵涉 `insertTranslationBlock` 的签名，只补 `textLang`）
- `auto-translate-wiring.test.mjs:531-543`（同上）

### 10.2 e2e 旅程（验收单元）

**通用规则**
- **期望的语言名一律在浏览器里用 Intl 现算**，例如 `page.evaluate(() => new Intl.DisplayNames(['en'], { type: 'language' }).of('fa'))`，不在测试里写死名字，也不借用被测实现来算期望。
- **遵守 `helpers.js:287-297` 的 `uiLanguage` 规则**：断言英文时不再冗余设置 `'en'`，断言中文时设置 `'zh-CN'`。
- **页面翻译用 AI 引擎，接 `mock-openai-server.js`。**
- **新夹具** `test/e2e/rtl-fixtures.js`，仿照 `display-fixtures.js`，经 `context.route` 提供 `https://rtl.test/`：
  - `/ltr`：英文段落，其中一段带 24px `<svg>` 前置图标；另有一个水平 flex 导航。
  - `/rtl`：`<html lang="he" dir="rtl">`，内容为希伯来文段落（同样有一段带前置图标）和一个 RTL 水平 flex 导航。

| 旅程 | 内容与断言 |
| --- | --- |
| **J-B1 设置页选择器** | `#targetLang` 有 76 项，每项文字等于 Intl 现算的名字，并按 `Intl.Collator` 排序。存了 `targetLang: 'fa'` 后重新加载页面，`value === 'fa'`（顺序陷阱）。把界面语言从 en 切到 zh-CN：名字变成中文，四个 select 的已选值都保住。`#uiLanguage` 显示本名，`#comicTargetLang` / `#pdfTargetLang` 各为 1 + 10 项。9 个芯片的文字等于 `nameOf` |
| **J-B2 设置页点名提示** | 用 `page.addInitScript` 在设置页的主世界给 `self.Translator` 打桩：`availability` 返回 `'available'`，`create` 返回回显译文的对象。设 `translationEngine: 'builtin'`。选 fa：出现 LocalOnly 点名句（句中形），下载按钮隐藏。改选 fr：点名句消失。回到 fa，把 `engineFallback` 切到 `allow-ai`：说法随之变成 AllowAi 那一句。不用 ar，因为 ar 是端上支持的语言 |
| **J-B3 阿拉伯语双语对照** | `/ltr` 页面，目标 ar。每个译文节点 `lang="ar"`、`dir="rtl"`。**几何断言**：用 Range 取译文首行文字的 rect，`right` 与块的内容盒右边相差 ≤ 1px，`left` 距离内容盒左边 > 10px。带图标的那段：译文的 `padding-left` 等于原文的缩进 |
| **J-B4 希伯来语仅译文** | 切到仅译文模式，目标 he。断言 `lang`、`dir`，右对齐几何同 J-B3；原文被隐藏后，译文仍然右对齐 |
| **J-B5 RTL 原文译成英文** | `/rtl` 页面，目标 en。译文 `lang="en"`、`dir="ltr"`，首行文字 `left` 贴近内容盒左边（左对齐）。带图标的那段：缩进写在 `padding-right`，并且 `padding-left` 为 0 |
| **J-B6 RTL 水平导航** | `/rtl` 页面的导航。`inline-right` 的 span 算出 `margin-right: 4px`、`margin-left: 0px`。几何：原文文字 rect 的 `left` 减去 span 的 `right` ≈ 4px（±1），也就是 span 整体在原文左侧 |
| **J-B7 悬停翻译** | mock 设 `delayMs`，以便抓到加载态。目标 ar。加载态 `lang` 为界面语言、`dir="ltr"`；结果 `lang="ar"`、`dir="rtl"`，右对齐几何同 J-B3 |
| **J-B8 页内语言菜单** | 用输入框对话框（`#ai-translator-input-dialog`，开法照 `input-translation.spec.js`）：它和划词卡共用 `setupLanguageDropdown`，打开不需要先有一次成功的翻译。同时设 `translationEngine: 'builtin'` 和 `autoTranslateEngine: 'builtin'`（helpers 的规则）。菜单 76 项，名字为界面语言、有序。fa 项有 `data-tag`，并且 `getComputedStyle(item, '::after').content` 等于带引号的标记文字；fr 项没有。选中 fa 后，标签文字等于名字本身，不含标记。菜单项没有横向溢出（`scrollWidth <= clientWidth`）。若 D 已先合入：打开菜单时已选项在可见区域内（§9） |
| **J-B9 划词卡 RTL** | 归后合入的一方（§12） |
| **U-B10 朗读无声音态** | 只做单测（§8） |
| **J-B11 OCR 标签与 PDF 任务名** | `image-ocr.spec.js:236` 改前提：界面语言 en 下期望 `Original · ` 加 Intl 算出的 `zh-Hans` 名；再加一条 `uiLanguage: 'zh-CN'` 的用例，期望 `简体中文`。PDF 任务或历史列表若已有渲染 `targetLang` 的 e2e（`pdf-history-link.spec.js` 等），期望同样改为 Intl 现算 |

**改前提的现有 e2e**

| 文件 | 改动 |
| --- | --- |
| `options-i18n.spec.js:21` | 期望改为 Intl 现算的 `zh-Hans` 英文名 |
| `image-ocr.spec.js:236` | 见 J-B11 |
| `input-translation.spec.js:254/:264`（P1 的文件） | 期望从 `日本語` 改为界面语言名（Intl 现算） |

## 11. 文档

- `README.md:313`：「支持多种目标语言（10+语言）」改为「支持 76 门目标语言：其中 39 门可用 Chrome 内置翻译免费在本机完成，其余 37 门走 AI」。
- `README.md:86`（英文段）：`Multi-language support (10+ languages)` 同步改为 `76 target languages (39 translated free on-device by Chrome's built-in Translator, the rest through your AI service)`。
- 其余描述照真实 DOM 核对。
- `CHANGELOG.md` 的 `## Unreleased` 下新增小节 `### 76 target languages and right-to-left layout`，内容为用户可见的变化，并写明 §0 的兼容影响。
- `_locales` 的 `appDescription` 没有写语言数量，不改。
- `docs/store-submission-*.md` 是历史记录，不改。

## 12. 接缝

| 对象 | 接缝 |
| --- | --- |
| **C（#106）** | B 叠在它上面，没有其他交集 |
| **D（划词卡）** | 不碰 `content-popup.js`。三件事都由**后合入的一方**做：（1）在 `setupLanguageDropdown` 的 `openMenu` 里调用 `revealSelectedLanguage`（一行覆盖划词卡和输入框对话框）；（2）划词卡译文的 `markLanguage`；（3）J-B9 旅程。若 D 先合，B 在 rebase 时补上并在 J-B8 断言滚动；若 B 先合，D rebase 时补上并在它的旅程里断言 |
| **E（上传页多格式）** | `options-pdf-tasks.js` 删 `PDF_TASK_LANG_KEYS`，E 的分支上行号不同（`:229` 附近用到 `currentUILang`）。i18n 文件相邻处的冲突，由后 rebase 的一方解决 |
| **P1** | B 在 P1 的文件里**只动**这几处，并在 PR 描述中逐条列出：`batch.js:347` 一行；`collect.js` 的 `getTextOffsetLeft`→`getTextInset`（函数体加导出行）；`content-input-chip.js:114` 一行（加 `:120-124` 注释）；`input-chip.test.mjs`、`input-translation.spec.js` 的前提修改。`content-input-dialog.js` 译文区（`:279` 写 `resultText` 处）的 `markLanguage` 一行，等 B 合入后由 P1 加；菜单滚动不用它加（§9）。manifest 的 `content_scripts` 不动，`content-language.js` 已在清单里 |
| **#107（P1-A）** | 与 B 重叠的文件：`content-bootstrap.js`、`batch.js`、`collect.js`、`engine/languages.js`、`content-translation-engine.js`、`i18n/lang/*.js`、`options.html`、`options.js`、`default-settings.js`。后合入的一方 rebase |

## 13. 遗留项

1. 自动翻译的源语言芯片仍是 9 个，只改了名字的来源。要扩到 76 门，需要另做交互（搜索或多选），不在本项范围内。
2. `sr` 默认西里尔字母。`sr-Latn` 浏览器会被收进 `sr`，拉丁字母用户需要另开一门 `sr-Latn`。
3. 受管译文用 `::after` 生成，伪元素上设不了 `lang`，只能设 `direction`。
4. 云端清单与 saas 对齐：
   - saas 的 `TARGET_LANGS` 有 28 门，其中是 `nb` 而不是 `no`，接口不校验 `targetLang`。
   - 「跟随」会把 76 门中的任意一门透传给云端。漫画重绘能否排好该文字（尤其是阿拉伯文字），由 saas 回答。
   - 建议 saas 校验并返回可见错误，或补字体。
5. 语言菜单没有键入跳转，76 项只能靠滚动。
6. `effectiveEngine` 对「仅 AI」的目标仍然先试内置。静态判定已经知道译不了，可以直接走 AI（allow-ai）或直接报错（local-only）。
7. 工具栏弹窗的状态文字，对「目标语言本身不支持」仍说成「这一对不支持」。
8. `allow-ai` 但 AI 未配置时，运行时点名句里「允许回退到 AI」的建议已不适用，真正的出路是配置 AI 服务。

## 14. 决策登记（台账 D-304）

- 目标语言清单 = Chrome 界面语言去重后的 76 门，唯一出处是 `TargetLang.SUPPORTED`。名字用 Intl 现算，分菜单形和句中形。
- 端上不支持：设置页静态判定并点名（两种说法），菜单上标「仅 AI」，运行时点名报错。弹窗状态不变。
- 译文打 `lang`/`dir`。异向对齐一律 `start`（居中、两端对齐除外）。缩进和间隙都在原文起始边。
- 云端维持 10 门，「跟随」透传。
- 「跟随浏览器」语义随清单扩大，兼容影响见 §0。

## 15. 实现偏差（实现时登记）

行号以分支 `feat/p0-b` 终版为准。「自决」指设计没写到、按最小改动定下的；「偏差」指与设计原文不一致的。

### 15.1 代码

1. 自决：`TargetLang.nameOf` 接受任何合法标签，Intl 不认识的码原样返回（`shared/target-lang.js:136`）；`direction` 对不合法标签答 `'ltr'`（`:164-166`）。OCR 和 PDF 任务元信息要给识别出的、清单外的语言起名，只接受 76 门会让这两处报错。
2. 自决：`fromTag` 先过 `Intl.getCanonicalLocales`，再把 `nb`/`nn` 并到 `no`（`shared/target-lang.js:67-81`）。Intl 只折叠 iw/in/tl 这类退役码，不做宏语言这一步。
3. 自决：设置页引擎回退下拉框变更时重算内置引擎状态（`options/options-builtin.js:87`），同步镜像里 `engineFallback` 也一并重算（`options/options-sync-mirror.js:27`）。点名句分 LocalOnly / AllowAi 两种说法，回退设置一变，句子必须跟着换。
4. 自决：静态判定为端上不支持的目标，不再调 `availability()`（`options/options-builtin.js:47-57`）。
5. 自决：PDF 任务元信息只在任务带 `targetLang` 时才写语言名（`options/options-pdf-tasks.js:217`）。「跟随」透传的任务没有这个字段。
6. 偏差：`shared/ocr.js` 删掉了 `detectedLanguageLabelKey` 和 `OCR_LANGUAGES[].labelKey`。OCR 标签改由 `ctx.languageName` 现算（`content/content-image-ocr.js:50`），对应单测按新前提重写。
7. 自决：加载态和错误文字标界面语言（`content/hover/render.js:38-39` `textLangOf`），不标目标语言；其余情况必须有 `textLang`，缺了就抛错。
8. 自决：`renderManagedTranslation` 缺 `textLang` 时抛错（`content/content-managed-translation.js:173-174`）。
9. 偏差：`buildBaseStyle` 签名改成 `(computedStyle, dir, omitColor)`（`content/hover/render.js:23`）。对齐要按译文方向算。
10. 自决：选区内联译文用 `ctx.getEffectiveTargetLang()` 打标（`content/hover/selection.js:341`），不用未归一化的 `settings.targetLang`。
11. 自决：字幕只在 `setOverlayContent` 处打标：原文行 `dir="auto"`（`content/captions/overlay.js:29`），译文行打有效目标语言（`:58`）。原文语言在字幕里拿不到可靠值，交给浏览器按首个强字符判定。
12. 偏差：`ctx.revealSelectedLanguage`（`content/content-language.js:90`）只导出、没有接线。菜单打开的入口在禁改文件 `content/content-popup.js` 里。J-B8 因此也不断言滚动到已选项（见 15.2 第 8 条）。
13. 自决：公式路径只打 `lang`/`dir`，不改对齐。
14. 自决：「仅 AI」标记（`data-tag` 的 `::after`，`content/css/popup.css:391-394`）不做浅色主题覆盖，沿用继承色加透明度。
15. 自决：无语音态透明度 0.45（`content/css/popup.css:457`）。以下两处都会清掉这个状态：`applyButtonState`（`content/content-speech.js:96`），以及按钮重新显示时（`:214`）。重试也从常态开始（`:135`）。
16. 自决：`spokenLang` 为空、或语音列表为空时不做无语音判定，照旧朗读（`content/content-speech.js:147`）。有的平台首次拿到的列表是空的，意思是「还没枚举」，不是「没有语音」。
17. 自决：`hasVoiceFor` 先用正则校验标签形状，再调 `Intl.getCanonicalLocales`（`shared/speech-lang.js:174-200`）。系统报来的畸形 voice.lang 不应让朗读抛错。
18. 自决：运行时点名报错只在 `targetLang` 非空时写语言名（`content/content-translation-engine.js:501-515`）。环境不支持、创建失败这两类原因与语言无关，调用处不传。
19. 偏差：`ctx.getTargetLangLabel` 保留（`content/content-language.js:31`）。禁改文件（`content/content-popup.js`、`content/content-selection.js`、`content/content-input-dialog.js`）还在调它；它现在转给 `ctx.languageName`，不再查表。
20. 自决：`background/settings.js:18` 的 `languageNames` 由 `TargetLang.promptName` 生成，覆盖 76 门。
21. 自决：删掉 `content/css/translation.css` 里 `.ai-translator-inline-right` 写死的 `margin-left: 4px`。改由插入方按原文方向写内联 `margin-${startSide}: 4px !important`（`content/page/insert.js:443`，`content/hover/render.js:83`、`:180`）。LTR 页几何不变（仍是左侧 4px），RTL 页改成右侧 4px、左侧 0。
22. 自决：新增 `ctx.uiLanguage()`（`content/content-bootstrap.js:47`），`ctx.t` 与加载态打标共用这一处。
23. 偏差：修了一个既有缺陷，文件是 `options/css/forms.css:300-305` 的 `.btn[hidden]{display:none}`。`.btn{display:inline-flex}` 压过了 UA 的 `[hidden]`，脚本把 `#downloadLanguagePack` 设为 hidden 后它仍在屏上。J-B2 要断言「fa 时隐藏」，必须先修。

### 15.2 测试

1. 偏差：`test/e2e/helpers.js:63`、`:68` 的 `PAGE_TRANSLATION_MODULES` 补上 `shared/target-lang.js` 和 `content/content-language.js`。这个文件不在任务书的 P1 允许列表里，也不在禁改列表里。直接注入整页翻译模块的 spec 缺了这两个文件，`markLanguage`/`startSide` 就不存在。
2. 前提变更：五个 spec 共 10 处 `insertTranslationBlock` 调用补上 `textLang`，因为 `textLang` 现在是必传项。旧前提是可省略，新前提是缺了就抛。涉及的 spec 是 markup-preservation、page-translation-placement、table-translation、translation-only-mode、page-translation-restamp。restamp（`test/e2e/page-translation-restamp.spec.js:48-49`）取 `a.lang`，没有时取当前目标语言。
3. 偏差、前提变更：`test/e2e/input-translation.spec.js:297` 不在 P1 允许列表（只列了 :254/:264）。旧前提是标签显示本名「Français」；新前提是 Intl 按界面语言算出的名字（en 界面下是「French」）；原因见 §2.5，菜单名一律用界面语言。:254/:264 同理改用 Intl 现算。
4. 偏差：设计要 J-B11 带一个「en 界面 + zh-Hans 识别」的用例。en 界面下本地 OCR 只加载 eng，vision mock 固定回英文，所以做不到。现在的用例是 en 界面 + vision 引擎 + 识别为 en，断言 `Original · <Intl en 名>`（`test/e2e/image-ocr.spec.js:281`）。en 界面的来历：从 `baseSettings()` 里去掉 zh-CN，沿用 harness 的英文，因为 `test/unit/e2e-harness.test.mjs:151` 禁止 spec 重写 `uiLanguage: 'en'`。zh-Hans 的查名由既有的大字号中文用例覆盖（`:243`，原先写死「简体中文」，现改为 Intl 现算）。
5. 自决：PDF 任务元信息的 Intl 名断言放在 `test/e2e/pdf-history-link.spec.js:88` 起的既有用例里：历史第 0 行 zh-Hans、第 1 行 en、进行中 ja。
6. 偏差：J-B2 的 Translator 桩返回 `'downloadable'`，设计写的是 `'available'`（`test/e2e/target-languages.spec.js:117-122`）。只有 `'downloadable'` 会让下载按钮出现，「选 fa 后隐藏」才是一条真断言。
7. 自决：J-B8 的页面由 `test/e2e/mock-server.js` 的 `startMockServer` 提供（`test/e2e/target-languages.spec.js:148`），spec 自己不起 http 服务。
8. 偏差：J-B8 不断言「打开时滚动到已选项」，原因见 15.1 第 12 条。
9. 自决：`test/e2e/rtl-fixtures.js:55-60` 让 `#p2` 带物理对齐（LTR 页 `left`、RTL 页 `right`）。没有它，「照抄原文对齐」的变异在 J-B3/J-B5 上不会变红。
10. 自决：mock server 与 mock-openai-server 都没有加选项。J-B7 用的 `delayMs` 是现成的。
11. 偏差：`content/content-input-chip.js:125` 的注释在允许范围 :120-124 之外一行。原注释拿瑞典语举「不在表上、会回落 en」的例子，sv 现在在 76 门里，改成 xh（科萨语）。`test/unit/input-chip.test.mjs:163-166` 同步改为 sv→sv、xh→en。
12. 前提变更：`test/e2e/display-fixtures.js:24-30` 的第一段原文删掉「separate」一词（P0-C 夹具，不在 P1 允许列表也不在禁改列表）。旧前提：J-C1（`test/e2e/translation-styles.spec.js:160`）的 `[T] …` 译文在 quote 的起始边内距（3px 边框 + 0.6em）下仍是一行。新前提：译文带 `lang="zh-CN"`，Chrome 对 zh-Hans 的 sans-serif 用另一套字体，拉丁字母宽约 6%，第一段译文从 594.7px 变成 630.2px，超过 quote 下约 627px 的内容宽，折成两行，把 `#p2` 往下推 24px。原因：给译文打 lang 是本批的要求（J-B3/J-B4），这一行的余量是夹具数据问题，不是 quote 样式引起的回流。删词后是 560.2px，default/quote 都是一行；三个 display spec 12 条全绿。第三段在 quote 下是 620.9px，余量约 6.5px，没有改。

### 15.3 文档

1. 自决：README 中英两段的「Supported Languages」拆成「翻译目标 76 门（39 门端上 / 37 门仅 AI）」和「界面 10 种」两条。
