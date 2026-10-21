# Chrome 网上应用店提交说明 — v1.5.3

提交日期：2026-10-21 ｜ 线上版本：1.5.1（2026-10-21 抓取详情页，扩展名仍是
「AI Translator for Web, PDF & Manga」）

> **1.5.2 不再单独上传。** 2026-10-20 从 `main` 打的 1.5.2 包之后，main 又合入了
> `<pre>` 文章的悬浮翻译（#178）、内嵌框架跟随自动翻译判定（#179）、图片悬浮栏
> 「翻译这页漫画」（#180）、同语言单词查词与语言菜单搜索框（#181）。版本号升到
> 1.5.3：不管 1.5.2 是否传过后台，1.5.3 都能上传。1.5.2 的包作废，不要上传。
> 线上用户仍在 1.5.1，所以第四节的更新说明写的是 1.5.1 → 1.5.3 的全部变化。

## 线上的 1.5.1 不是 main 打的那一版

2026-10-19 用 crawl-store 抓线上详情页：版本 1.5.1，扩展名「AI Translator for
Web, PDF & Manga」，简短说明「AI translator: free bilingual web pages, PDF
translation that keeps layout, manga translation, …」。这两句只存在于
`release/1.5.1`（`64a8a06`，基于已上架的 1.5.0 代码 `57880d9`）。

所以线上用户拿到的还是 1.5.0 的代码加改过的文字，**#149 以来合入的功能都还没发**：
Blab 引擎、Blab 识图、输入框、常用语言优先、离线词典，以及之后的全部修复。这一版
从 `main` 打包，把它们一次发出去。线上详细说明也仍是旧稿（「Bring the AI you
trust local models」漏了 cloud or），这次必须整份重贴。

Blab 识图的服务端已在生产上线，生产主模型能读图（2026-10-20 确认）。

## 一、包信息

| 项 | 值 |
| --- | --- |
| 上传文件 | `blab-translation-1.5.3.zip`（`npm run zip` 产物，仓库里不跟踪 zip） |
| 扩展版本 | 1.5.3 |
| 打包源 | 本说明所在 PR 合入后的 `main` |
| 新增权限 | **`unlimitedStorage`**（见第五节） |
| `minimum_chrome_version` | 116 → **130** |
| host_permissions / CSP | 未改动 |

相对线上 1.5.1 所基于的 1.5.0 代码，`manifest.json` 多了：`unlimitedStorage`、
五个界面语言文件（`i18n/lang/{ar,id,vi,tr,it}.js`）、离线词典与识图等新内容脚本，
以及最低 Chrome 版本。相对作废的 1.5.2 包（`e64f86be`），只多了一个内容脚本
`content/page/text-runs.js`，权限、host_permissions、CSP、最低 Chrome 版本都没变。

## 二、扩展名与简短说明（在包里，15 种）

| 语言 | 扩展名（≤75） | 字数 | 简短说明字数（≤132） |
| --- | --- | --- | --- |
| en | Blab Translation: AI Translator for Web, PDF, Manga & Subtitles | 63 | 128 |
| zh_CN | 叭叭翻译：AI 翻译网页、PDF、漫画与字幕 | 22 | 61 |
| zh_TW | 叭叭翻譯：AI 翻譯網頁、PDF、漫畫與字幕 | 22 | 61 |
| de | Blab Translation: KI-Übersetzer für Web, PDF, Manga & Untertitel | 64 | 132 |
| es | Blab Translation: traductor con IA para web, PDF, manga y subtítulos | 68 | 130 |
| fr | Blab Translation : traducteur IA pour web, PDF, manga et sous-titres | 68 | 131 |
| pt_BR | Blab Translation: tradutor com IA para web, PDF, mangá e legendas | 65 | 132 |
| ru | Blab Translation: ИИ-переводчик сайтов, PDF, манги и субтитров | 62 | 131 |
| ja | Blab Translation：Web・PDF・マンガ・字幕のAI翻訳 | 36 | 69 |
| ko | Blab Translation: 웹·PDF·만화·자막 AI 번역 | 35 | 81 |
| **ar**（新） | Blab Translation: مترجم ذكاء اصطناعي للويب وPDF والمانغا والترجمة النصية | 72 | 129 |
| **id**（新） | Blab Translation: Penerjemah AI untuk Web, PDF, Manga & Subtitle | 64 | 128 |
| **vi**（新） | Blab Translation: Trình dịch AI cho web, PDF, manga và phụ đề | 61 | 117 |
| **tr**（新） | Blab Translation: Web, PDF, Manga ve Altyazı için Yapay Zeka Çevirmeni | 70 | 129 |
| **it**（新） | Blab Translation: traduttore IA per web, PDF, manga e sottotitoli | 65 | 132 |

简短说明七项写全：双语网页、网页里选定的区域、保留排版的 PDF、电子书与 Word、
漫画、图片文字（OCR）、YouTube 字幕。en 原文：

> Bilingual web pages or just the part you pick, PDFs with layout kept, ebooks & Word, manga, image text (OCR), YouTube subtitles.

## 三、商店详细说明（在后台粘贴）

- 后台「商品详情」里**先为 ar、id、vi、tr、it 五种语言新增语言区域**，否则包里的
  名字会显示，但说明是空的（或回落到英文）。
- **15 个语言区域都整份粘贴** [`docs/store-listing/<locale>.txt`](store-listing/)。
  线上至少 en 还是更早的旧稿。
- 「图片文字（OCR）」一节有一条：订阅后也可以交给 Blab Translation 识别、无需
  密钥；「默认保护隐私」一节写明识图时发到服务器的是图片。
- 截图本地化这一版不做（调研文档 §5：一次只改一个变量）。

## 四、更新说明（可直接粘贴）

**中文**

> 1.5.3
> - 新增 Blab Translation 引擎：订阅自带，无需 API 密钥；订阅用户也能用它识别图片文字。
> - 漫画页悬停大图时，可直接点「翻译这页漫画」。
> - 新增离线词典：查单词先查本机词典包，可在设置里下载、更新、删除。
> - 新增阿拉伯语、印尼语、越南语、土耳其语、意大利语界面。
> - 整页和自动翻译先译你正在看的部分；悬浮球外圈显示翻译进度。
> - 首次使用：默认用意译风格；快捷键没分配上时提供「设置快捷键」按钮；安装前打开的标签页会提示刷新后再翻译。
> - 查的词已是目标语言时，给出该语言的释义（像单语词典）。
> - 语言菜单顶部显示最近用过的语言，并可输入名称搜索；输入框标出由哪个引擎翻译。
> - 修复：单页应用重绘菜单时译文闪回原文、写在 <pre> 里的文章不翻译（悬停也能译）、带斜体的松散段落被拆碎翻译、内置引擎下公式与引用标记出错、漫画任务名称、网格排版里译文位置。
> - 现在需要 Chrome 130 或更高版本。

**English**

> 1.5.3
> - New: Blab Translation engine, included with a subscription, no API key needed. Subscribers can also use it to read text in images.
> - Hover a large image on a comic page and click "Translate This Comic".
> - New: offline dictionary. Word lookups check a downloaded pack first; download, update or delete packs in Settings.
> - New interface languages: Arabic, Indonesian, Vietnamese, Turkish, Italian.
> - Whole-page and automatic translation start with the part you are reading; a ring around the float ball shows progress.
> - First run: free translation is the default style, a "Set a shortcut" button appears when a shortcut is missing, and tabs opened before installing ask for a reload instead of failing.
> - Looking up a word already in your target language gives a definition in that language, like a monolingual dictionary.
> - The language menu starts with the languages you used last and has a search box; the input box shows which engine translated.
> - Fixes: menus rebuilt by single-page sites no longer flash back to the original, articles inside a wrapping <pre> are translated (hover too), loose paragraphs with italics are no longer translated in pieces, plus formulas and citation markers on the built-in engine, comic job names, and translation placement in grid layouts.
> - Chrome 130 or later is now required.

## 五、权限理由与审核员说明

`<all_urls>` 理由、Single purpose、Remote code、Data types、审核员说明全部沿用
[store-submission-1.5.1.md](store-submission-1.5.1.md) 第五节（那一版已写进 Blab
引擎）。新增一栏：

**`unlimitedStorage` 理由**

> Used only for the offline dictionary. With the offline dictionary switched on (the default; it can be turned off in Settings), the extension downloads a dictionary pack for the user's language pair (checked against a published checksum) and stores it in the extension's local storage (chrome.storage.local) so single-word lookups work offline without sending the word anywhere. One pack can take more than the 10 MB that chrome.storage.local allows by default. Packs are listed in Settings with their size, and each can be deleted there. No browsing data is stored.

离线词典包从 `blab-translation.com` 的公开地址下载，内容是词典数据，不是代码，
Remote code 仍选 No。

Blab Translation 识图不新增权限：图片由内容脚本取到、经后台发给已在用的账户站接口，
和 Blab 翻译同一条通道。Data types 里「网站内容」已勾选，覆盖用户主动送去识别的图片。

## 六、提交前 checklist

- [x] Blab 识图服务端已上线、生产主模型能读图（2026-10-20 确认）
- [x] `manifest.json` 版本是 1.5.3，打包源是本 PR 合入后的 `main`
- [x] 15 种语言 `appName` ≤75、`appDescription` ≤132 字符
- [ ] 上传 zip；新增 ar/id/vi/tr/it 五个语言区域；15 个区域的说明整份换成
      `docs/store-listing/<locale>.txt`；更新说明贴第四节
- [ ] Privacy practices：补 `unlimitedStorage` 理由（第五节）；核对隐私政策链接是
      `https://blab-translation.com/app/legal/privacy`
- [ ] 在调研文档 §7 改动日志记一行「1.5.3 上架」的日期
- [ ] 上架一周后复测搜索词：manga translator、pdf translator、ai translator、
      dual subtitles、Blab Translation
