# Chrome 网上应用店提交说明 — v1.5.1

提交日期：2026-10-14 ｜ 上一个提交版本：1.5.0（2026-10-07，商店 10-08 上线）

这一版从 `main` 打包，包含 1.5.0 上架之后合入的全部功能和修复，同时改了商店能被
搜到的文字（扩展名、简短说明、详细说明）。1.5.0 实际上架的代码是 `57880d9`；
相对它，这一版新增：

- **Blab Translation 引擎**（#149）：订阅自带、无需 API 密钥的第三种引擎，
  文本发到我方服务器翻译；
- **输入框**（#151）：标出由哪个引擎作答，内置引擎答短词时提示没有词典释义、
  可一键改用 AI / Blab；日、韩、泰文最多 8 个字符按单词查词；
- **常用目标语言优先**（#151）：输入框和划词卡片的语言菜单顶部有「最近使用」
  一组（最多 5 个）；
- 修复：内置引擎掉花括号的占位符（#146）、被拆成 ` . ` 的行内标记（#147）、
  漫画任务带页面标题入库（#150）、grid / flex 行里译文落进序号列（#153）；
- 每日额度按 token 显示（#155）。

完整条目见 `CHANGELOG.md` 的 1.5.1 一节。Blab 引擎原先被写在 1.5.0 下面，但
1.5.0 的包里没有它，这次挪到了 1.5.1。

## 为什么改商店文字

2026-10-12 实测商店英文搜索（crawl-store，tag `cws-seo`）：

| 搜索词 | Blab 的位置 |
| --- | --- |
| Blab Translation | 第 1 |
| bilingual pdf epub word（冷门词） | 第 3（共 3 个结果） |
| pdf translation / translate pdf | 前 10 没有 |
| ai translation | 前 10 没有 |
| manga translation / comics translation | 前 10 没有 |
| dual youtube subtitles | 前 10 没有 |

说明文字会被索引（冷门词能搜到），但热门词前 10 名几乎都把搜索词写在扩展名里。
我们的扩展名只有品牌名，十种语言的说明里也一次都没出现 manga、AI translator、
PDF translation 这几个原词。另一半原因是装机量（当时 48 个用户、1 条评分），
改文字只能解决前一半。

## 一、包信息

| 项 | 值 |
| --- | --- |
| 上传文件 | `blab-translation-1.5.1.zip`（`npm run zip` 产物，仓库里不跟踪 zip） |
| 扩展版本 | 1.5.1 |
| 打包源 | 本说明所在 PR 合入后的 `main` |
| 新增权限 / host_permissions / CSP 变化 | **无** |

`git diff 57880d9 <打包源> -- manifest.json` 只有两处变化：版本号，以及
`content_scripts` 的加载列表多了四个文件（`shared/engines.js`、
`content/content-local-pref.js`、`content/engine/model.js`、
`content/content-engine-choice.js`）。`permissions`、`host_permissions`、
`web_accessible_resources` 和 CSP 都没动。Blab 引擎调用的是
`https://blab-translation.com/api/blab/complete`，和 PDF、漫画用的是同一个
账号服务，原有的 `<all_urls>` 已经覆盖。

## 二、扩展名与简短说明（在包里）

| 语言 | 扩展名（≤75） | 简短说明（≤132） |
| --- | --- | --- |
| en | Blab Translation: AI Translator for Web, PDF, Manga & Subtitles（63） | Bilingual web pages or just the part you pick, PDFs with layout kept, ebooks & Word, manga, image text (OCR), YouTube subtitles.（128） |
| zh_CN | 叭叭翻译：AI 翻译网页、PDF、漫画与字幕 | 双语对照网页（也可只译选定区域），保留排版的 PDF，电子书与 Word，漫画，图片文字（OCR），YouTube 字幕。 |

扩展名放搜索量最大的几项（AI 翻译、网页、PDF、漫画、字幕）。简短说明把七项能力
写全：网页、网页里选定的区域、PDF、电子书与文档、漫画、图片文字（OCR）、YouTube
字幕。网页、PDF、漫画、字幕在扩展名和简短说明里各出现一次（1.5.0 的两栏也是
这样），同一栏里不重复。其余八种语言都是 en 的翻译，拉丁字母的语种都不超过
132 个字符（de、pt_BR 正好 132）。

扩展名只出现在商店、`chrome://extensions`、工具栏悬停提示，以及右键菜单里多项
并列时 Chrome 自动生成的那一级。设置页和弹窗里显示的名字读的是
`i18n/messages.js`，不受影响。

写法沿用 1.5.0 两次被警告后定下的规矩：

- 同一栏里每个关键词只出现一次，不成串罗列品牌、服务商或网站名，不写任何竞品名。
- 只写代码做得到的事。漫画只写 manga / comics，**不写 webtoon、manhwa**，因为
  长条漫画在 `content/comic/prompts.js` 里会报 `webtoon_strip` 不支持。
  「保留排版」只用来形容 PDF：Word / EPUB 等产出的是双语文件，MOBI 是在阅读台里
  读的。
- 「免费」只用来形容默认的端侧网页翻译。

## 三、商店详细说明（在后台粘贴）

十个语言区域的说明都在 [`docs/store-listing/<locale>.txt`](store-listing/)，
**十个都要整份重新粘贴**。这次先改 en，其余九份逐段同步：

- 第二段从两种引擎改成三种：端侧翻译、自带密钥的 AI、订阅自带的 Blab Translation；
- 「双语网页」一节新增一条：只想译一部分，就点选那块区域选「只翻译这里」
  （`pickerInclude`）；站点规则那条相应去掉重复的「只翻译这里」；
- 「划词、悬停、查词」一节新增一条：最近选过的语言排在语言菜单最前面
  （`langRecent`）；
- OCR 从漫画一节拆出来单列（「TEXT IN ANY IMAGE (OCR)」）：任意图片都能右键识别，
  不只是漫画——截图、照片、图表都行；整张或自己框一块，大图悬停有「Recognize Text」按钮
  （`ocrRecognizeText`，各语言写各自的界面文字）；本机离线识别，或用自带密钥的视觉模型。
  漫画一节只剩「MANGA & COMICS」一条；
- 隐私一节：原来写的是「选 AI 引擎时文本直接发到你的接口，从不经过我们」，
  有了 Blab 引擎之后这句不再全对，改成「自己的 AI 模型」，并新增一条：Blab Translation
  会把文本发到我们的服务器翻译，不保存任何内容。

（1.5.0 与上一稿 1.5.1 已改过：第二段写上 manga，标题写成「PDF TRANSLATION」。）

**另一个必须整份粘贴的理由：** 10-12 抓到的线上 en 说明还是更早的稿子，和
#145 定稿不一致。照仓库文件整份覆盖即可。

## 四、更新说明（可直接粘贴）

**中文**

> 1.5.1
> - 新增 Blab Translation 引擎：订阅自带，无需 API 密钥。
> - 输入框会标出由哪个引擎翻译；内置引擎查短词时可一键改用 AI 拿到词典释义。
> - 语言菜单顶部显示最近用过的语言。
> - 修复：内置引擎下公式与引用标记出错、漫画任务名称、网格排版里译文位置。

**English**

> 1.5.1
> - New: Blab Translation engine, included with a subscription, no API key needed.
> - The input box shows which engine translated; a short lookup on the built-in engine can be sent to AI for a full dictionary entry.
> - The language menu starts with the languages you used last.
> - Fixes for formulas and citation markers on the built-in engine, comic job names, and translation placement in grid layouts.

## 五、权限理由与审核员说明

### `<all_urls>` 理由 ⚠️ 改写最后一句

其余各栏沿用 [store-submission-1.5.0.md](store-submission-1.5.0.md) 第四节。
`<all_urls>` 一栏整段换成下面这段：前面与 1.5.0 相同，只改了最后一句并补了
Blab 一句。

> The extension's single purpose is translating the page the user is on, and that can be any page, including text inside its iframes and web components. Most pages are translated only when the user asks (toolbar button, context menu, keyboard shortcut). A page may also be translated **automatically**, and that is under the user's control: it runs only while the "Translate pages automatically" switch is on (the first row of the toolbar popup, and in Settings). It applies only to sites the user set to Always and to a short built-in list of reading sites (e.g. arXiv, Google Scholar, Reddit, Hacker News, Stack Overflow, major news sites). **On every other site the page text is left alone: nothing on the page is read for translation and nothing is sent.** The one exception is video subtitles: while the same switch is on, on any site the user has not set to Never, the subtitle lines a video player shows through a standard subtitle track are translated as the video plays, and go to the chosen engine like page text; setting the site to Never or turning the switch off stops them. Private-message pages (X, Facebook, Instagram, Reddit and Bluesky chats) and a built-in list of mail, banking, payment and document-editing sites are excluded from automatic translation; the list is not exhaustive, and a site the user sets to Always is translated. Frames served by a built-in list of ad, payment, captcha and sign-in providers are never read. Text already in the user's language is skipped. Every rule, built-in or the user's own, is listed in Settings and can be turned off there; Alt+A pauses the current page. The default engine is Chrome's on-device Translator, so on default settings **no page text leaves the device**. With the user's own AI model chosen (which for automatic translation takes an explicit confirmation), the text goes to the endpoint the user entered, with the user's own key, never to us, and no-click translation is capped per day (200,000 characters by default). The third engine, Blab Translation, is used only after the user selects it; Settings greys it out unless the signed-in account includes it, and our service refuses requests from accounts without it. With it chosen, the text to translate is sent to our service at blab-translation.com, translated by our model provider and not stored.

**Single purpose**（不变）：Translate web content — selected text, whole pages,
video subtitles, text inside images, PDFs and documents — using a translation
engine the user chooses.

**Remote code**：仍然选 **"No, I am not using remote code"**。Blab 引擎只收发
文本，不下发代码。

**数据用途 / Data types**：仍是 1.4.0 / 1.5.0 那五个勾。Blab 引擎发送的是页面
文本，属于已勾的 Website content，不用多勾；它不保存文本，只按账号记当天用掉的
token 数。漫画任务现在会带上页面标题（#150），和页面网址一样属于 Website content。

**Privacy policy URL**：`https://blab-translation.com/app/legal/privacy`。线上
这页已经写了 Blab Translation 会把文本发到我方服务器、不保存原文（saas
`server/content/legal/*/privacy.ts`）。

### 审核员说明（Reviewer notes）

第 1–7 步沿用 [store-submission-1.5.0.md](store-submission-1.5.0.md) 第五节，
**最后一段换成：**

> PDF, document and comic translation, and the optional Blab Translation
> engine, are the only features that use our servers. They need a sign-in
> (Google or GitHub). Nothing is uploaded until the user presses Translate or
> Alt+M, and Blab Translation is used only after the user selects it as the
> translation engine in Settings, in a site rule, or on one card; requests
> from accounts whose plan does not include it are refused.

## 六、提交前 checklist

- [x] `manifest.json` 版本是 1.5.1，打包源是 `main`
- [x] `permissions` / `host_permissions` / CSP 未改动（只多了四个内容脚本）
- [x] 十种语言 `appName` ≤75、`appDescription` ≤132 字符
- [x] `npm run test:unit` 全绿
- [ ] 上传 zip；十个语言区域的「说明」整份换成 `docs/store-listing/<locale>.txt`；
      更新说明贴第四节
- [ ] Privacy practices：`<all_urls>` 理由换成第五节那段；审核员说明换掉最后一段
- [ ] **后台隐私政策链接改成 `https://blab-translation.com/app/legal/privacy`**
      （10-12 线上详情页显示的还是旧域名 `translators-ai.com/zh/legal/privacy/`）
- [ ] 上架一周后复测「为什么改商店文字」一节的六个搜索词
