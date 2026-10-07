# Chrome 网上应用店提交说明 — v1.5.0

提交日期：2026-10-07 ｜ 上一个提交版本：1.4.0（2026-09-20）

这一版有两件事要在后台改，不只是传一个新 zip：

1. **商店文案换了写法。** 简短说明（`appDescription`）和详细说明都改成「双语对照
   网页翻译 + PDF 保留排版 + 视频双语字幕 + EPUB/Word 文档 + 主流 AI 模型」的
   句式，第二节是可以整段粘进后台「说明」框的详细简介。1.3.0 起三次记下、一直
   没改的「无中间服务器 / no middleman」那句，这次直接在新文案里换成有限定的
   说法（见第二节末尾），不用再记第四次。
2. **`<all_urls>` 的理由和审核员测试步骤又要重写。** 1.4.0 的两段都建立在
   「这一页要翻译吗？」那条询问条上 —— 它在这一版被删掉了：没上任何名单的网站
   现在什么都不做。照抄 1.4.0 的答案，审核员按第 2、3 步走会找不到那条询问条。

## 一、包信息

| 项 | 值 |
| --- | --- |
| 上传文件 | `blab-translation-1.5.0.zip`（`npm run zip` 产物，仓库里不跟踪 zip） |
| manifest 版本 | 3 |
| 扩展版本 | 1.5.0 |
| 最低 Chrome 版本 | 116（未变） |
| 新增权限 | **无** |
| 新增 host_permissions | **无** |
| 打包源 | `main` @ 最后一次改动本文件的那个 PR 合并之后 |

相对 1.4.0，`manifest.json` 的变化：

- 版本号；
- 三个新快捷键：`Alt+T`（双语 / 仅译文）、`Alt+W`（翻译整页）、`Alt+M`（翻译
  PDF 或漫画）；
- `<all_urls>` 那一组内容脚本加了 `all_frames`、`match_about_blank`、
  `match_origin_as_fallback` —— 让整页翻译能进 iframe 和 Shadow DOM。广告、
  支付、验证码、登录类的子框在 `shared/frame-eligibility.js` 里被挡掉，内容脚本
  在那里什么都不建、什么都不读；
- 内容脚本清单里新增的文件。

**`permissions`、`host_permissions`、`content_security_policy` 一个字节都没改。**

`_locales/*/messages.json` 十种语言的 `appDescription` 全部重写，每条 ≤132 字符：

| 语言 | 简短说明 | 字符数 |
| --- | --- | --- |
| zh_CN | 免费的原文/译文双语对照网页翻译：PDF 翻译保留排版，YouTube 等视频双语字幕，EPUB/Word 电子书与文档，漫画翻译，数学公式不乱；支持 OpenAI、Claude、Gemini、DeepSeek 等 AI 大模型。 | 115 |
| en | Free bilingual web page translation. PDFs keep their layout, dual YouTube subtitles, EPUB/Word, comics. OpenAI, Claude, Gemini. | 127 |

其余八种语言（zh_TW、ja、ko、de、es、fr、pt_BR、ru）同一句式，见各自的
`messages.json`。

**两样没写进去，因为代码不支持：** DeepL（引擎预设里没有）和 Netflix（字幕翻译
只有 YouTube 专用通道，加上任何暴露标准 `<track>` / `TextTrack` 的 HTML5 播放
器）。沉浸式翻译的简介里有这两样，我们的没有，别在后台文案里补上。

## 二、商店详细说明（可直接粘贴进「说明」）

### 中文

> 【叭叭翻译】免费的原文/译文双语对照网页翻译插件。PDF 翻译保留原版排版，
> YouTube 等视频双语字幕，EPUB、Word、MOBI 电子书与文档翻译，漫画翻译；
> 支持 OpenAI (GPT)、Claude、Gemini、DeepSeek、OpenRouter 等 AI 大模型，
> 也支持 Ollama、LM Studio 本地模型和 Chrome 自带的端上离线翻译。
>
> ■ 双语对照网页翻译
> · 译文排在原文下面，一段对一段，原文的格式、链接、图片都不动；一键切到
> 「仅译文」（Alt+T）。
> · 只翻正文：导航、侧栏、菜单默认保持原文，读起来干净；需要时 Alt+W 翻整页。
> · iframe 和 Web Components（Shadow DOM）里的文字也能翻。
> · 数学公式、LaTeX、代码保持原样，学术页面不乱码。
> · 六种译文样式：默认、下划线、虚线框、高亮、引用条、悬停才显示的模糊。
> · 76 种目标语言，阿拉伯语、希伯来语等从右往左排的语言版式正确。
>
> ■ 自动翻译
> · arXiv、Hugging Face Papers、Google 学术、Reddit、X、Hacker News、Medium、
> Stack Overflow、纽约时报、BBC、路透社等常用的论文、社区和新闻网站，打开就是
> 译文；别的网站一键加入「总是翻译」。
> · 已经是你母语的段落自动跳过，夹着英文术语也认得出来。
> · 私信页面永远不会自动翻译。
> · 每条规则都在设置页里列着，随时删除；Alt+A 暂停当前页。
>
> ■ PDF 翻译（保留排版）
> · 把论文、报告翻成双语对照 PDF 或纯译文 PDF，图表、公式、版式都留在原位，
> 在网页阅读台里直接看。
> · 每月有免费页数，登录后使用。
>
> ■ 电子书与文档翻译
> · 支持 Word（.docx）、EPUB、MOBI / AZW3、TXT、Markdown，输出双语或纯译文
> 文件。
>
> ■ 视频双语字幕
> · YouTube 字幕边播边译，原文和译文上下两行。
> · 其他网站上，凡是带标准字幕轨的 HTML5 播放器都能用。
> · 播放器控制条里一键开关译文字幕。
>
> ■ 划词翻译与查词
> · 选中文字旁出现翻译图标，点开卡片：重译、切换引擎、复制、朗读。
> · 选中一个单词或短语，给出词典释义：目标语言的读音、词性、例句、词形变化。
> · 按住修饰键指一段，就译这一段。
> · 输入框里打的字和网页不是一门语言时，角上出现「译成 …」，点了才翻。
>
> ■ 漫画与图片翻译
> · 漫画页面原地重绘成你的语言，也可以上色。
> · 图片里的文字本地 OCR 识别后翻译。
>
> ■ 隐私
> · 网页翻译默认用 Chrome 端上的离线翻译，文字不出你的电脑；选用 AI 时，文字
> 直接发到你自己填的接口、用你自己的密钥，不经过我们的服务器。
> · 漫画和 PDF / 文档翻译需要把文件上传到我们的服务器处理，结果 7 天后自动删除。
> · 不埋点、不做广告追踪。
>
> 快捷键：Alt+A 翻译 / 还原当前页 · Alt+T 双语 / 仅译文 · Alt+W 翻译整页 ·
> Alt+M 翻译 PDF 或漫画。可在 chrome://extensions/shortcuts 修改。
>
> 隐私政策：https://blab-translation.com/app/legal/privacy

### English

> Blab Translation — free bilingual web page translation, with the original and
> the translation side by side. PDF translation that keeps the layout, dual
> subtitles on YouTube and other video sites, EPUB, Word and MOBI documents,
> and comics. Works with OpenAI (GPT), Claude, Gemini, DeepSeek, OpenRouter,
> local models through Ollama or LM Studio, and Chrome's own on-device
> translator.
>
> ■ Bilingual web pages
> · Each translation sits under its paragraph; the page's formatting, links and
> images stay as they are. Switch to translation only with Alt+T.
> · Main content only: navigation, sidebars and menus stay in the original so
> the page reads cleanly. Alt+W translates the whole page when you want it.
> · Text inside iframes and web components (Shadow DOM) is translated too.
> · Math, LaTeX and code are kept intact, so papers stay readable.
> · Six translation styles: default, underline, dashed box, highlight, quote
> bar, and blur until hovered.
> · 76 target languages, with right-to-left languages such as Arabic and Hebrew
> laid out correctly.
>
> ■ Automatic translation
> · arXiv, Hugging Face Papers, Google Scholar, Reddit, X, Hacker News, Medium,
> Stack Overflow, The New York Times, BBC, Reuters and other paper, community
> and news sites translate on open. Add any other site to "Always translate"
> in one click.
> · Paragraphs already in your language are skipped, even when they are full
> of foreign terms.
> · Private-message pages are never translated automatically.
> · Every rule is listed in Settings and can be deleted; Alt+A pauses the page.
>
> ■ PDF translation that keeps the layout
> · Turn papers and reports into a bilingual or translation-only PDF, with
> figures, formulas and layout where they were, and read it in the web reader.
> · A free monthly page allowance; sign-in required.
>
> ■ Ebooks and documents
> · Word (.docx), EPUB, MOBI / AZW3, TXT and Markdown, saved as a bilingual or
> translated file.
>
> ■ Dual video subtitles
> · YouTube subtitles are translated as the video plays, original and
> translation on two lines.
> · Works on any other site whose HTML5 player has a standard subtitle track.
> · One click in the player's control bar turns the translated subtitles on or
> off.
>
> ■ Selection translation and dictionary
> · Select text and click the icon beside it: retranslate, switch engine, copy,
> read aloud.
> · Select a word or short phrase for a dictionary entry: pronunciation in your
> target language, senses by part of speech, examples and word forms.
> · Hold a modifier key and point at a paragraph to translate just that one.
> · Typing in another language than the page's? A "Translate to …" chip appears
> in the text box and translates only when clicked.
>
> ■ Comics and images
> · Comic pages are redrawn in your language in place, and can be colorized.
> · Text in images is recognised by on-device OCR and translated.
>
> ■ Privacy
> · Web page translation runs on your device by default, with Chrome's built-in
> translator: the text never leaves your computer. With an AI engine, the text
> goes straight to the endpoint you entered, with your own key, never through
> our servers.
> · Comic, PDF and document translation upload the file to our servers to do
> the work; results are deleted automatically after 7 days.
> · No analytics, no ad tracking.
>
> Shortcuts: Alt+A translate or restore the page · Alt+T bilingual or
> translation only · Alt+W translate the whole page · Alt+M translate a PDF or
> comic. Change them at chrome://extensions/shortcuts.
>
> Privacy policy: https://blab-translation.com/app/legal/privacy

「隐私」一节就是 1.3.0 起记了三次的那条限定写法：网页翻译默认在端上、不经
中间服务器；漫画、PDF 与文档要上传到我方服务器。**原来那句无条件的「无中间
服务器 / no middleman」整句删掉，不要留在后台文案里。**

## 三、本次更新说明（可直接粘贴）

**中文**

> 1.5.0
> - PDF 之外，新增 Word、EPUB、MOBI、TXT、Markdown 文档翻译；翻完在网页阅读台
>   里看，下载菜单里有双语与纯译文文件。
> - 划词：选中文字旁出现翻译图标；卡片可重译、切换引擎、复制、朗读。选中单词
>   或短语给出词典释义（目标语言读音、词性、例句、词形），公式照常翻译。
> - 76 种目标语言，从右往左的语言版式正确。
> - 六种译文样式；双语 / 仅译文可在弹窗、悬浮球、设置和 Alt+T 切换，仅译文时
>   指着译文能看原文。
> - 整页翻译进入 iframe 和 Shadow DOM，尊重 `translate="no"`；默认只翻正文，
>   Alt+W 翻整页。
> - 站点翻译规则：在页面上点选区域，设「不翻译这里」「保留原文」「只翻译这里」，
>   可指定引擎、加 CSS，随账号同步，可导入导出。
> - 自动翻译：去掉询问条，没上名单的网站保持安静；内置名单加入常用社交、问答与
>   新闻网站；私信页面永不自动翻译；弹窗第一行就是自动翻译总开关。
> - 已是母语的段落按句判断，夹着外文名词也会跳过。
> - 视频：默认帮你打开视频自带字幕；播放器里一键开关译文字幕。
> - Alt+M 翻译当前 PDF 或漫画；未登录时先登录，回来自动继续。
> - Ollama、LM Studio 等本地模型不用填 API Key；接口错误按界面语言提示。
> - 首次安装有欢迎页；设置可导出导入。
> - 新的弹窗与悬浮球外观；全屏视频时悬浮球自动让开。

**English**

> 1.5.0
> - Document translation beyond PDF: Word, EPUB, MOBI, TXT and Markdown. A
>   finished document opens in the web reader, whose download menu has the
>   bilingual and translated files.
> - Selection: a translate icon appears beside the selection; the card can
>   retranslate, switch engine, copy and read aloud. A selected word or phrase
>   gets a dictionary entry (pronunciation in your target language, senses,
>   examples, word forms); formulas are still translated.
> - 76 target languages, with right-to-left layout.
> - Six translation styles; bilingual or translation only from the popup, the
>   float ball, Settings or Alt+T, with the original one hover away.
> - Page translation reaches iframes and Shadow DOM and respects
>   `translate="no"`; main content by default, the whole page with Alt+W.
> - Site translation rules: pick an area on the page and choose "Don't
>   translate here", "Keep original" or "Only translate here"; pin an engine,
>   add CSS; rules sync and can be exported and imported.
> - Automatic translation: the ask bar is gone and unlisted sites stay quiet;
>   common social, Q&A and news sites join the built-in list; private-message
>   pages are never translated automatically; the popup's first row is the
>   on/off switch.
> - Text already in your language is checked sentence by sentence and skipped
>   even when it carries foreign names.
> - Video: the video's own subtitles are switched on for you; one click in the
>   player turns the translated subtitles off and on.
> - Alt+M translates the PDF or comic on screen; signed out, it signs you in and
>   carries on.
> - Local models (Ollama, LM Studio) need no API key; API errors are shown in
>   your interface language.
> - A welcome page on first install; settings export and import.
> - A new look for the popup and the float ball, which steps aside for
>   full-screen video.

完整技术记录见 [CHANGELOG.md](../CHANGELOG.md) 的 1.5.0 一节。

## 四、权限理由（Privacy practices 表单逐条填写）

**本次没有新增任何权限。** 只有 `<all_urls>` 一栏要换（询问条删了），其余各栏
沿用 [store-submission-1.4.0.md](store-submission-1.4.0.md) 第三节，原样粘贴。

| 权限 | 理由（可直接粘贴） |
| --- | --- |
| `<all_urls>` ⚠️**改写** | The extension's single purpose is translating the page the user is on, and that can be any page, including text inside its iframes and web components. Most pages are translated only when the user asks (toolbar button, context menu, keyboard shortcut). A page may also be translated **automatically**, and that is under the user's control: it runs only while the "Translate pages automatically" switch is on (the first row of the toolbar popup, and in Settings). It applies only to sites the user set to Always and to a short built-in list of reading sites (e.g. arXiv, Google Scholar, Reddit, Hacker News, Stack Overflow, major news sites). **Every other site is left alone: nothing is read for translation and nothing is sent.** Private-message pages (X, Facebook, Instagram, Reddit and Bluesky chats) and mail, banking, payment and document-editing sites are never translated automatically, and frames for ads, payments, captchas and sign-in are never read at all. Text already in the user's language is skipped. Every rule, built-in or the user's own, is listed in Settings and can be turned off there; Alt+A pauses the current page. The default engine is Chrome's on-device Translator, so on default settings **no page text leaves the device**. With an AI engine chosen (which for automatic translation takes an explicit confirmation), the text goes to the endpoint the user entered, with the user's own key, never to us, and no-click translation is capped per day (200,000 characters by default). |

**Single purpose**（不变）：Translate web content — selected text, whole pages,
video subtitles, text inside images, PDFs and documents — using a translation
engine the user chooses.

**Remote code**：仍然选 **"No, I am not using remote code"**。

**数据用途 / Data types**：与 1.4.0 相同的五个勾（PII、Authentication、Website
content、User activity、Web history），理由见 1.4.0 文档。这一版新增的文档翻译
（Word / EPUB / MOBI / TXT / Markdown）与 PDF 走同一条路：文件上传到我方私有存储，
任务记录挂在账号上 —— 落在已勾的 Website content 与 User activity 里，不用多勾。
AI 提示词里新增的「页面类型」只发四种标签之一（社交 / 论坛 / 新闻 / 学术），
**不发网址**。

**Privacy policy URL**：`https://blab-translation.com/app/legal/privacy`
（已上线，联系邮箱 support@blab-translation.com 已在正文里）。

## 五、给审核员的测试说明（Reviewer notes）

> Automatic translation is on by default, but it only ever acts on a short
> built-in list of reading sites and on sites the user turned on. Everything
> below runs on Chrome's on-device Translator, so **no text is sent anywhere**.
>
> 1. Install. A welcome page opens. Choose **Japanese** as the target language
>    there, so the English test sites below are foreign to it, then press the
>    download button beside the language-pack status: Chrome's on-device
>    translator needs that pack, and it is only fetched when the button is
>    pressed.
> 2. Open a page on a site that is on no list, e.g.
>    `https://en.wikipedia.org/wiki/Chrome_Web_Store`. **Nothing happens** — no
>    bar, no translation, no request. Click the toolbar icon and press
>    "Translate this page": now it translates, and Alt+A restores it.
> 3. Open `https://news.ycombinator.com/`, which is on the built-in list. It
>    translates on open, with no click.
> 4. In the toolbar popup, switch "Auto-translate this site" off: the page
>    returns to the original and stays that way on that site. Settings →
>    "Translate pages automatically" lists that rule with a button to remove it,
>    and shows the built-in list folded underneath, each site with a switch.
> 5. Private messages are never auto-translated: on `x.com/messages` (signed in
>    to X) nothing is translated, even though the rest of x.com is on the list.
> 6. Open a YouTube video and play it. Its own subtitles are switched on and
>    each line is shown with its translation underneath. The Blab Translation
>    icon in the player's control bar (just before CC) turns the translated
>    subtitles off and on.
> 7. "On this computer" in Settings shows local counters
>    (`shared/auto-stats.js`, `chrome.storage.local`, never uploaded) with a
>    Clear button; the translation cache has a Clear button of its own.
>
> PDF, document and comic translation are the only features that use our
> servers. They need a sign-in (Google or GitHub), and nothing is uploaded
> until the user presses Translate or Alt+M.

## 六、提交前 checklist

- [x] `manifest.json` 版本已升到 1.5.0（高于已提交的 1.4.0）
- [x] `permissions` / `host_permissions` / CSP 未改动
- [x] `_locales/` 十种语言的 `appDescription` 已重写并全部 ≤132 字符
- [x] `npm run test:unit` 全绿
- [x] `npm run test:e2e` 全绿
- [x] `npm run zip` 产物已校验：十种 `_locales` 齐全、Tesseract 核心与语言包在内、
      无 `.DS_Store`、无 source map、无测试文件
- [ ] 在 `chrome://extensions/` 用「加载已解压的扩展程序」实测一遍第五节
- [ ] 上传 zip；后台「说明」整段换成第二节（**删掉旧的 no middleman 那句**）；
      更新说明贴第三节；`<all_urls>` 理由用第四节新写的那段
