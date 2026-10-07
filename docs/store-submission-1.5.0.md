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

**2026-10-07 第一次提交被拒（Yellow Argon，关键词堆砌）。** 审核引用的是英文
详细说明里两串名字：AI 服务商一串（OpenAI (GPT)、Claude、Gemini、DeepSeek、
OpenRouter、Ollama、LM Studio）和自动翻译的网站一串（arXiv … Reuters）。第二节
已改写成不列名单的说法，中文版同步改，私信那句的五个社交网站名也一并去掉；
更新说明里的 Ollama、LM Studio 也换成「本地运行的模型」。简短说明
（`appDescription`，十种语言）末尾同样列着 OpenAI、Claude、Gemini（部分语言
还有 DeepSeek），审核没点名但是同一类问题，一并改成「你自己的 AI 模型」。
**以后写商店说明：不要成串罗列品牌、服务商或网站名**；要说明支持面，就说类别
（「你自己的 AI 模型」「常用论文与新闻网站」），具体名单留在扩展的设置页里。
只有扩展确实专门适配、且说明离不开的名字（如 YouTube 字幕）才写，一处一个。
简短说明在 zip 里，所以重新提交要**重传 zip**（版本仍是 1.5.0），并把后台「说明」
整段换成第二节。

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
  `match_origin_as_fallback` —— 让整页翻译能进 iframe 和 Shadow DOM。
  `shared/frame-eligibility.js` 按一份固定的主机名单挡掉广告、支付、验证码、
  登录服务商的子框，内容脚本在那些子框里什么都不建、什么都不读（名单之外的
  同类子框不在其内，文案里也只这么说）；
- 内容脚本清单里新增的文件。

**`permissions`、`host_permissions`、`content_security_policy` 一个字节都没改。**

`_locales/*/messages.json` 十种语言的 `appDescription` 全部重写，每条 ≤132 字符：

| 语言 | 简短说明 | 字符数 |
| --- | --- | --- |
| zh_CN | 免费的原文/译文双语对照网页翻译：PDF 翻译保留排版，YouTube 等视频双语字幕，EPUB/Word 电子书与文档，漫画翻译，数学公式不乱；也可接入你自己的 AI 大模型。 | 89 |
| en | Free bilingual web page translation. PDFs keep their layout, dual YouTube subtitles, EPUB/Word, comics. Bring your own AI model. | 128 |

其余八种语言（zh_TW、ja、ko、de、es、fr、pt_BR、ru）同一句式，见各自的
`messages.json`。

**两样没写进去，因为代码不支持：** DeepL（引擎预设里没有）和 Netflix（字幕翻译
只有 YouTube 专用通道，加上任何暴露标准 `<track>` / `TextTrack` 的 HTML5 播放
器）。沉浸式翻译的简介里有这两样，我们的没有，别在后台文案里补上。

## 二、商店详细说明（可直接粘贴进「说明」）

每个语言区域一个文件：[`docs/store-listing/<locale>.txt`](store-listing/)，
一段 / 一条一行，整份复制粘贴到该语言区域的「说明」框即可。

- `en.txt` 是默认语言区域（English），其余九份（de / es / fr / ja / ko /
  pt_BR / ru / zh_CN / zh_TW）都是它的逐段翻译，结构、条目、数字一一对应。
- **改说明时先改 `en.txt`，再同步改其余九份。** 商店会比对各语言区域与默认
  语言区域的说明，内容不一致会被当作「误导性元数据」警告（2026-10-07 收到过）。
- 不要罗列品牌、服务商或站点名（第一次被拒的理由是关键字堆砌），只写类别。

## 三、本次更新说明（可直接粘贴）

**中文**

> 1.5.0
> - PDF 之外，新增 Word、EPUB、MOBI、TXT、Markdown 文档翻译；翻完在网页阅读台
>   里看，除 MOBI 外下载菜单里有双语与纯译文文件。
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
> - 本地运行的模型不用填 API Key；接口错误按界面语言提示。
> - 首次安装有欢迎页；设置可导出导入。
> - 新的弹窗与悬浮球外观；全屏视频时悬浮球自动让开。

**English**

> 1.5.0
> - Document translation beyond PDF: Word, EPUB, MOBI, TXT and Markdown. A
>   finished document opens in the web reader, whose download menu has the
>   bilingual and translated files (MOBI is read in the reader only).
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
> - Models running on your computer need no API key; API errors are shown in
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
| `<all_urls>` ⚠️**改写** | The extension's single purpose is translating the page the user is on, and that can be any page, including text inside its iframes and web components. Most pages are translated only when the user asks (toolbar button, context menu, keyboard shortcut). A page may also be translated **automatically**, and that is under the user's control: it runs only while the "Translate pages automatically" switch is on (the first row of the toolbar popup, and in Settings). It applies only to sites the user set to Always and to a short built-in list of reading sites (e.g. arXiv, Google Scholar, Reddit, Hacker News, Stack Overflow, major news sites). **On every other site the page text is left alone: nothing on the page is read for translation and nothing is sent.** The one exception is video subtitles: while the same switch is on, on any site the user has not set to Never, the subtitle lines a video player shows through a standard subtitle track are translated as the video plays, and go to the chosen engine like page text; setting the site to Never or turning the switch off stops them. Private-message pages (X, Facebook, Instagram, Reddit and Bluesky chats) and a built-in list of mail, banking, payment and document-editing sites are excluded from automatic translation; the list is not exhaustive, and a site the user sets to Always is translated. Frames served by a built-in list of ad, payment, captcha and sign-in providers are never read. Text already in the user's language is skipped. Every rule, built-in or the user's own, is listed in Settings and can be turned off there; Alt+A pauses the current page. The default engine is Chrome's on-device Translator, so on default settings **no page text leaves the device**. With an AI engine chosen (which for automatic translation takes an explicit confirmation), the text goes to the endpoint the user entered, with the user's own key, never to us, and no-click translation is capped per day (200,000 characters by default). |

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
