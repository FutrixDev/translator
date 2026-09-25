# 隐私政策 — 叭叭翻译 / Blab Translation Privacy Policy

最后更新：2026-09-21 ｜ 适用版本：1.4.0 起
Last updated: 2026-09-25 ｜ Applies from: version 1.4.0

> 这一页要能贴到 Chrome 网上应用店的 **Privacy policy URL** 里，所以它写的是
> 事实，不是承诺：每一条都能在源码里指到具体文件。哪天代码改了而这一页没改，
> 那就是这一页错了。

---

## 一句话 / In one sentence

**扩展本身不收集你的任何数据。** 它把你要翻译的文字发给**你自己配置的**那个接口；
默认引擎跑在你自己的电脑上，连这一步都不出去。没有埋点、没有统计上报、没有第三方
分析。

**有例外，而且只有一处：漫画翻译和文档翻译（PDF、Word、EPUB、MOBI、TXT、Markdown）。** 这两项跑在我们的服务器上，所以
要先登录。一旦你用了它们，我们这边就有一个属于你的账号：你的邮箱、你这个月还剩
多少免费页数、以及你跑过的每一个任务；文件本身也会上传给我们处理。**不碰这两项
功能，就没有账号，上面这些东西一样都不存在。** 细账见第二节。

**The extension itself collects nothing.** It sends the text you want translated
to the API **you configured yourself**, and on default settings that engine runs
on your own computer, so not even that leaves. There is no analytics, no
telemetry, no third-party SDK.

**There is one exception, and only one: comic translation and document translation (PDF, Word, EPUB, MOBI, TXT, Markdown).**
They run on our servers, so they require signing in. Once you use them we hold an
account for you — your email address, how many free pages you have left this
month, and a record of every job you have run — and the file itself (the image, or
the whole document) is uploaded to us to do the work. **If you never touch those two features there is no
account and none of that exists.** Section 2 is the itemised list.

---

## 一、文字去了哪里 / Where your text goes

| 功能 | 去向 | 说明 |
| --- | --- | --- |
| 网页翻译（含自动翻译） | **Chrome 内置翻译引擎（默认，完全离线）**，或你在设置里填的 OpenAI 兼容接口 | 默认引擎是 Chrome 端上的 Translator API，译文在你的电脑里算出来，一个字节都不出去。改成 API 引擎后，要翻译的那几段文字会发到**你填的那个地址**，用**你自己的 API key**。我们看不到，也收不到。 |
| 划词 / 悬停 / 输入框翻译 | 同上 | 同一条路，同一个引擎设置。输入框角上那颗「译成 …」的小芯片是在本机判断你打的是哪门语言，**你点它之前什么都不发**。 |
| 视频字幕翻译 | 同上 | 发出去的是字幕文本，不是视频、不是音频。跟着自动翻译走：没被你设成「从不翻译」的站点上，字幕随播放自动翻。 |
| 图片文字识别（OCR） | **默认在本机**（打包在扩展里的 Tesseract，离线运行）；也可以选用你自己的视觉模型 | 选本机引擎时图片不出电脑。选视觉模型时，图片会发到你填的那个接口。 |
| **漫画翻译** | **我们的服务器**（`blab-translation.com`） | 需要登录。图片上传到我们的服务器处理，处理完返回结果。连同上传的还有**那张图所在的网址**，见第二节。 |
| **文档翻译**（PDF、Word、EPUB、MOBI、TXT、Markdown） | **我们的服务器**（`blab-translation.com`） | 需要登录。整个文件经一次性预签名地址直接上传到对象存储（本机文件由扩展的上传页上传；网页上的 PDF 由扩展后台下载后上传），文件名跟着任务记录一起存下来。Word、EPUB、TXT、Markdown 在上传前会在本机数一下篇幅（只把页数报给服务器，不另外发送内容）。任务在服务器上排队；比预计长时会先问你，完成后通知你。 |

**自动翻译不改变这张表。** 它改变的只是「什么时候开始翻译」—— 从「你点一下」
变成「这一页符合你设的规则时自动开始」，视频字幕也一样。发出去的还是同样的文字，
发到同样的地方，用同样的引擎。默认引擎是离线的那个，所以**一台没改过设置的机器上，
自动翻译不产生任何网络请求**。你让这些不用点的翻译走 AI 接口时，它们每天最多花
多少字符由你在设置页里定（默认 20 万），这个数在本机记账，不上传。

**Automatic translation does not change that table.** It changes *when*
translation starts — from "you clicked" to "this page matches a rule you set,"
and the same goes for video subtitles. The same text goes to the same place
through the same engine. The default engine is the offline one, so on a machine
with default settings, automatic translation makes no network request at all.
If you point these no-click translations at an AI endpoint, you set how many
characters they may spend per day (200,000 by default); that tally is kept on
your computer and never uploaded.

**整页翻译读哪些内容、不读哪些：**

- **嵌在页面里的 frame 和 shadow DOM 里的正文也会翻译。** 文章嵌在 iframe 里、
  网页组件把正文放进 shadow DOM，这些文字和页面上别的正文一样，走上面那张表里
  同一个引擎、同一条路。
- **广告、支付、验证码、登录这几类 frame，扩展从不读取。** 这样的 frame 里扩展的
  脚本在启动那一刻就停下，不读页面内容、不发消息（`shared/frame-eligibility.js`）。
- **网页标了 `translate="no"` 或 `.notranslate` 的内容，永远不会发出去。** 整块
  这样标的跳过；句子里这样标的词（产品名、人名）原样留在本机，不进翻译请求。
- **默认只翻正文。** 导航、侧栏、页眉页脚不送去翻译；要翻整页，用悬浮球菜单里的
  「翻译整个页面」，或在设置里把范围改成整页。
- **这些都没有新增权限。** 权限清单和上一版一样，见第四节。

**What page translation reads, and what it never reads:**

- **Text inside embedded frames and shadow DOM is translated too.** An article
  inside an iframe, or a web component that keeps its text in a shadow root,
  goes through the same engine and the same path as the rest of the page, per
  the table above.
- **Ad, payment, captcha and sign-in frames are never read.** In such a frame
  the extension's script stops the moment it starts: it reads none of the
  page's content and sends nothing (`shared/frame-eligibility.js`).
- **Content the page marks `translate="no"` or `.notranslate` is never sent.**
  A block marked that way is skipped; a word marked that way inside a sentence
  (a product or person name) stays on your machine and is not part of the
  request.
- **Only the main content is translated by default.** Navigation, sidebars,
  headers and footers are not sent; to translate the whole page, use
  "Translate Whole Page" in the float ball's menu, or change the scope in
  Settings.
- **None of this adds a permission.** The permission list is unchanged; see
  section four.

---

## 二、账号：漫画和文档那一半 / The account behind comic and document translation

漫画翻译和文档翻译是仅有的两项不用你自己 API key 的功能 —— 它们跑在我们的服务器
上，靠一个按月重置的免费页数额度。要有额度就要有账号，所以**这两项功能的代价就是
这一节**。

| 我们这边存下了什么 | 什么时候产生的 | 源码里在哪 |
| --- | --- | --- |
| 你的邮箱，可能还有显示名 —— 由 Google 或 GitHub 在你授权时提供 | 第一次登录 | 登录发生在 `blab-translation.com/ext/connect` 这个网页上，OAuth 全程在那里完成，扩展只拿回一个令牌（`background/comic-client.js` 的 `signIn()`） |
| 免费额度：这个月还剩几页、几号重置 | 每次用这两项功能 | `GET /api/billing/me`；设置页上那几个数字就是它 |
| 任务记录：每个漫画 / 文档任务的状态、文档的**文件名**和格式、漫画那张图**所在页面的网址** | 每次发起一个任务 | `/api/comic/jobs`、`/api/pdf/jobs`（`background/comic-client.js`、`background/pdf-client.js`） |
| 文件本身：漫画的那张图、文档的整个文件 | 每次发起一个任务 | 字节由扩展上传；六种文档格式都经一次性预签名地址直传对象存储（本机文件由 `pdf/upload.js` 上传，网页上的 PDF 由 `background/pdf-client.js` 上传），不经过我们的 API 服务器 |

两件值得单独说的事：

- **这份记录跟着账号走，不跟着设备走。** 换一台电脑登录同一个账号，看到的是同一份
  历史 —— 设置页里能列出你在别的设备上跑过的任务，就是因为这个。
- **漫画翻译会把那张图所在页面的网址一起发过来**，这是整份政策里唯一一处网址离开
  你电脑的地方，而且只发生在你亲手点下「翻译这张图」的那一刻。网页翻译、划词、
  字幕、OCR 都不发送任何网址，自动翻译也不发送。

Comic and document translation are the only two features that do not use your own API
key: they run on our servers against a monthly free page allowance, which is why
they need an account. Using them means we hold your email address (supplied by
Google or GitHub when you authorise the sign-in), your remaining free pages, and
a record of every job — with the file name and format for a document, and **the address of the
page the image came from** for a comic. That job history belongs to the account,
not to the device, which is why the settings page can list jobs you started
elsewhere. The comic page URL is the only address that ever leaves your computer,
and only at the moment you click "translate this image".

---

## 三、存在你电脑上的东西 / What is stored on your machine

| 内容 | 位置 | 跟着账号同步吗 |
| --- | --- | --- |
| 设置（接口地址、模型、目标语言、各种开关） | `chrome.storage.sync` | 是 —— 这是 Chrome 的账号同步，数据在 Google 那里，不经过我们 |
| 站点规则（你对每个网站定下的「总是翻译 / 从不翻译」） | `chrome.storage.sync` | 是，同上 |
| API key | `chrome.storage.sync` | 是，同上。**我们从不读取、不上传它**；它只在你的浏览器里被拼进发给你自己接口的请求 |
| 登录令牌（漫画 / 文档翻译用） | `chrome.storage.local` | **否**，只在这台设备上 |
| 本机统计（这个月自动翻了几页、缓存省了多少、发出去多少字符，以及今天不用点的翻译用掉了多少 AI 字符 —— 每日额度靠它算） | `chrome.storage.local` | **否，而且从不上传**。见 `shared/auto-stats.js` |
| 译文缓存（30 天过期） | `chrome.storage.local` | 否 |

**「本机统计」那一块是给你自己看的镜子，不是我们的埋点。** 它之所以放在
`local` 而不是 `sync`，正是为了这句话能站得住：`sync` 跟着账号走，这几个数字不
该跟着走。设置页里有一颗「清除」按钮，按下去就没了。

The stats panel is a mirror for you, not telemetry for us. It is in `local`
rather than `sync` precisely so that claim holds, and the settings page has a
button that clears it.

---

## 四、权限为什么要 / Why each permission

| 权限 | 用途 |
| --- | --- |
| `<all_urls>` | 扩展的功能就是翻译你正在看的那一页，而那可以是任何一页；也包括页面里嵌入的 frame（广告、支付、验证码、登录类的除外，见第一节） / Translating the page you are reading, which can be any page, including the frames embedded in it (except the ad, payment, captcha and sign-in frames listed in section one) |
| `storage` | 存上面那张表里的东西 |
| `activeTab` | 你从工具栏或右键菜单发起的那一次翻译 |
| `contextMenus` | 右键菜单里的那几条 |
| `identity` | 漫画 / 文档翻译的登录流程 |
| `notifications` | 文档任务完成、需要你确认（比预计长）、已取消时告诉你 |
| `alarms` | 只在有文档任务运行时，每分钟查一次它的状态（MV3 的 service worker 不能长期挂定时器）；没有运行中的任务就撤掉 |
| `offscreen` | 跑本机 OCR 引擎（它需要 Web Worker 和 WebAssembly，service worker 里跑不了） |

---

## 五、我们不做的事 / What we do not do

- 不出售数据，不把数据用于与功能无关的任何用途，不做信用评估或贷款审批。
- 不收集浏览历史。扩展知道你打开了哪一页，**是因为它要在那一页上干活**，这件事
  不会被记录，也不会被发送 —— 自动翻译尤其不会。两处例外，都写在别处了：你自己
  定下的「总是翻译 / 从不翻译」存在你的浏览器里（第三节），而漫画翻译会把那张图
  所在页面的网址发给我们（第二节）。
- 不使用任何第三方分析 SDK。整个代码库里搜不到一个。
- 不下载或执行远程代码。所有 JS 和 WASM 都在安装包里。

---

## 六、删除你的数据 / Deleting your data

- **你电脑上的**：设置、站点规则、译文缓存、本机统计，都能在设置页里清 —— 站点
  规则一行一个删除按钮，统计和译文缓存各有一颗「清除」；或者直接卸载扩展，Chrome
  会把这个扩展的 `storage` 一并删掉。
- **我们服务器上的**（账号、任务记录、上传过的文件）：**在设置页「退出登录」只是
  删掉这台设备上的令牌，服务器上的东西还在。** 要真删，发邮件到下面那个地址，
  说明要删除账号。

What is on your computer — settings, site rules, the translation cache and the
local statistics — can be cleared in the settings page or removed wholesale by
uninstalling the extension. What is on our servers is a separate act: **signing
out only deletes this device's token**, so ask for account deletion at the
address below.

---

## 七、联系 / Contact

有任何问题，或者要求删除服务器上的数据：**（发布前填入联系邮箱）**

> ⚠️ 这一行是**唯一一处没法从源码里查出来的内容**，必须由发布者填。Chrome 网上
> 应用店的审核会点这个 URL，留着占位符提交等于自找一轮退回。
