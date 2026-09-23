# Chrome 网上应用店提交说明 — v1.4.0

提交日期：2026-09-20 ｜ 上一个上架版本：1.3.1（2026-08-18 提交）

**这一版和 1.3.1 不是一个量级。** 1.3.1 是补丁；1.4.0 加了一整条产品线 ——
自动翻译 —— 而它**改变了 `<all_urls>` 这个权限在实际使用中的含义**。权限清单
一个字没动，但审核员看的是行为，不是清单。所以第三节的 `<all_urls>` 理由必须
重写，不能照抄 1.3.0 那一版（那一版写的是 "Content scripts only translate when
the user asks"，**现在这句话不成立了**）。

## 一、包信息

| 项 | 值 |
| --- | --- |
| 上传文件 | `blab-translation-1.4.0.zip` |
| manifest 版本 | 3 |
| 扩展版本 | 1.4.0 |
| 最低 Chrome 版本 | 116（未变） |
| 新增权限 | **无** |
| 新增 host_permissions | **无** |
| 打包源 | `main` @ 最后一次改动本文件的那个 PR 合并之后 |

相对 1.3.1，`manifest.json` 只有三处变化：版本号、新增一个 `commands`（Alt+A
快捷键）、以及内容脚本清单里多出来的那些文件。**`permissions`、
`host_permissions`、`content_security_policy` 一个字节都没改。**

`_locales/*/messages.json` 十种语言的 `appDescription` 全部重写，把「自动」
提到了第一句（每条仍在 132 字符以内）。

## 二、本次更新说明（可直接粘贴）

**中文**

> 1.4.0 — 自动翻译
> - 新增：自动翻译。你设成「总是翻译」的网站、以及我们内置名单里的网站，
>   打开就是译文，不用点；别的网站会先问你一次，答过就记住。
>   要不要翻，按三样东西决定，优先级从高到低：**你对这个网站的决定 > 我们内置
>   的网站名单 > 你勾选的「只自动翻这些语言」**。所以你设成「从不翻译」的网站，
>   哪天换了语言也还是不翻。
> - 新增：一次点击就能是一个长期答案。没决定过的页面上会出现一条询问「这一页
>   要翻译吗？」，勾上「总是翻译 这个网站」再点「翻译」，就给这个网站记了一条
>   规则，以后不再问；点「不用」只管这一次，问满三次就不再问。不想让某个网站
>   自动翻，在工具栏弹窗里把「自动翻译这个站点」关掉，或者点悬浮球菜单里的
>   「不再自动翻译 这个网站」。规则对子域名有效（对 `reddit.com` 的决定管得住
>   `old.reddit.com`）。
> - 新增：**所有规则都在设置页里列着，每一条都能删。** 手滑按错的那一下，
>   一键就能撤销。
> - 新增：不留痕迹地暂停。Alt+A、工具栏图标、悬浮球都能开关当前这一页，
>   只管这一次访问，不写任何规则。
> - 新增：视频字幕跟着同一个决定走。没被你设成「从不翻译」的网站上，字幕随播放
>   自动翻；设了的，字幕也不翻。播放器菜单第一行就是「自动翻译这个站点」，和
>   工具栏弹窗是同一条规则。
> - 新增：不用离开页面就能叫停。悬浮球菜单第一行「不再自动翻译 这个网站」，
>   一下写好规则、页面恢复原文。
> - 新增：单页应用跟得上了。站内换一篇文章，和打开一个新页面是一样的待遇。
> - 新增：论文与阅读站点。arXiv 的摘要、全文（HTML 版）和列表页，Hugging Face
>   Papers，Lobsters、bioRxiv、Nature、Science，以及 Google 学术（含 .com.hk、
>   .co.jp、.de 等各国域名）打开就是译文；作者、引用、参考文献这些译了反而
>   没法用的地方保持原文。arXiv 的 PDF 只给一条提示条 —— PDF 翻译按页计费，
>   **你点之前什么都不发**。
> - 新增：自动翻译有自己的引擎，默认是 Chrome 端上的离线翻译，不管手动翻译用
>   的是哪个；切到 AI 要先确认。不用点的翻译（自动页面、视频字幕）每天最多花
>   多少 AI 字符由你定，默认 20 万，只在本机记账；用完了会说一声，第二天自己
>   恢复。
> - 新增：输入框里的「译成 …」小芯片。你打的字和页面不是一门语言时出现在
>   输入框角上，点了才翻，从不改你的原文；语言判断在本机做。设置里可以关。
> - 新增：译文缓存。同样的文字、同样的引擎和模型，不会再发第二次 —— 第二次
>   访问是免费的，按返回键是瞬间的。条目 30 天过期，设置页里也有一颗按钮随时
>   清空它。
> - 新增：设置页里的「本机统计」。这个月自动翻了几页、缓存替你省下多少、真正
>   发给模型多少字符。**这几个数字只存在你这台电脑上，不同步、不上传**，
>   旁边就有清除按钮。
> - 修复：「译成哪门语言」只剩一个答案。法语浏览器上右键菜单写着「译成
>   Français」、整页却译成了简体中文，这类前后不一致没有了；繁体浏览器也不会
>   再在繁体标签下拿到简体译文。
> - 修复：换了界面语言，右键菜单立刻跟上。
> - 修复：字幕也用译文缓存，同一个视频再看一遍不会为同样的句子再付一次钱。
> - 修复：缺少内置语言包而停住的页面，在语言包装好的那一刻会自己活过来，
>   不用再刷新。
> - 修复：设置页里二十七条在其他九种语言下仍是英文的文案，全部补齐。

**English**

> 1.4.0 — Automatic translation
> - New: pages translate themselves. On a site you set to Always — and on the
>   sites our built-in list covers — the page is translated on open, with no
>   click; anywhere else you are asked once and the answer is kept. Three
>   things decide it, in this order: **your decision about this site > our
>   built-in site list > the languages you ticked to have translated.** A site
>   you told us to leave alone stays alone, even after it changes language.
> - New: one click can be a permanent answer. An undecided page shows a bar
>   asking "Translate this page?" — tick "Always translate this site" and press
>   Translate, and a rule is written and the bar never comes back; "Not now"
>   is for this visit, and a site asked three times is not asked again. To
>   keep a site from translating itself, switch off "Auto-translate this site"
>   in the toolbar popup, or use "Stop auto-translating" on the float ball.
>   Rules cover subdomains.
> - New: **every rule is listed in Settings, and every one of them can be
>   deleted there.** An answer you gave by accident is one click from undone.
> - New: pause without deciding. Alt+A, the toolbar popup and the float ball
>   each toggle the page you are on, for this visit only, leaving no rule.
> - New: video subtitles follow the same decision. On a site you have not
>   turned off, subtitles are translated as they play; on one you have, they
>   are not. The first row of the in-player menu is the same "translate this
>   site automatically" rule the toolbar popup shows.
> - New: stop a site without leaving the page — the float-ball menu's first
>   row writes the rule and restores the original text.
> - New: single-page apps are followed — a new article on a site that never
>   reloads is treated like a fresh page.
> - New: papers and reading sites. arXiv abstracts, full HTML papers and
>   listings, Hugging Face Papers, Lobsters, bioRxiv, Nature, Science and
>   Google Scholar (including its country domains such as .co.jp and .de)
>   translate on open, leaving authors, citations and reference lists in the
>   original. arXiv PDFs only get an offer: PDF translation is billed per page,
>   so **nothing is sent until you click it**.
> - New: automatic translation has an engine of its own — Chrome's on-device
>   translator by default, whatever you use for manual translation — and
>   switching it to AI asks first. What no-click translation (pages and video
>   subtitles) may spend on AI is capped per day by you, 200,000 characters by
>   default, counted on this computer only; when it runs out you are told, and
>   it comes back the next day.
> - New: a "Translate to …" chip in text boxes. It appears at the corner when
>   what you type is not in the page's language, translates only when clicked,
>   and never rewrites your text; the language check is done locally. It can be
>   switched off in Settings.
> - New: a translation cache. The same text through the same engine and model
>   is never sent twice, so a second visit is free and the back button is
>   instant. Entries expire after 30 days, and Settings has a button that
>   empties it on the spot.
> - New: "On this computer" in Settings — pages translated this month, what
>   the cache saved, and the characters that actually reached the model.
>   **These numbers stay on your machine: not synced, never uploaded**, and
>   there is a button that clears them.
> - Fixed: one answer to "which language do I translate into" — no more
>   context menu offering French while the page is translated into Chinese.
> - Fixed: the context menu follows a change of interface language at once.
> - Fixed: subtitles use the translation cache, so watching a video again does
>   not pay for the same lines twice.
> - Fixed: a page stuck waiting on a built-in language pack now recovers the
>   moment the pack lands, instead of staying blank until a reload.
> - Fixed: twenty-seven settings strings that were still English in the other
>   nine languages.

完整技术记录见 [CHANGELOG.md](../CHANGELOG.md) 的 1.4.0 一节。

## 三、权限理由（Privacy practices 表单逐条填写）

**本次没有新增任何权限。** 但 `<all_urls>` 的那一栏必须重写 —— 它在 1.3.x 下的
理由里有一句 "Content scripts only translate when the user asks"，1.4.0 之后这句
话不再成立。隐瞒它就是在赌审核员不会装一遍，而这一赌输掉的代价是整个扩展下架。

| 权限 | 理由（可直接粘贴） |
| --- | --- |
| `<all_urls>` ⚠️**改写** | The extension's single purpose is translating the page the user is on, and that can be any page. From 1.4.0 a page may also be translated **automatically**, so this permission now covers reading page text without a per-page click. The user is in control of when that happens and it is visible at every step. It runs only while the "Automatic translation" switch is on (one click in Settings turns the whole feature off). On sites the user set to Always, and on a short built-in list of reading sites (e.g. arXiv, Reddit, Hacker News, Google Scholar), a page translates on open; on every other site a bar asks first, and nothing is translated or sent before the user answers. Video subtitles follow the same decision: on a site the user has not turned off, subtitle lines are translated as they play. Text already in the user's language is left alone. Every answer is stored as a rule the user can see and delete in Settings; a per-visit pause is one keystroke (Alt+A), and a site can be turned off from the toolbar popup, the float ball or the in-player menu. The default engine is Chrome's on-device Translator, so on default settings **no page text leaves the device at all**. With an API engine chosen — which for automatic translation takes an explicit confirmation — the text goes to the endpoint the user entered, with the user's own key, never to us, and what no-click translation may send there is capped per day (200,000 characters by default). |
| `storage` | Stores the user's own settings (API endpoint, model, target language, feature toggles), their per-site automatic-translation rules, the translation cache, the local usage counters, and the sign-in token. |
| `activeTab` | Runs a translation on the tab the user explicitly acted on (toolbar button or context menu). |
| `contextMenus` | The right-click entries for translating a selection/page and for recognising text in an image. |
| `identity` | `chrome.identity.getRedirectURL()` / web auth flow for signing in to the optional account used by comic and PDF translation. |
| `notifications` | Server-side PDF translation outlives the page that started it; the notification tells the user when the job finished or failed. |
| `alarms` | Polls that PDF job's status once a minute — an MV3 service worker cannot hold a long-lived timer. |
| `offscreen` | Runs the bundled Tesseract OCR engine, which needs a Web Worker and WebAssembly. An MV3 service worker cannot spawn a nested Worker or instantiate this WASM. Created on demand and closed afterwards. |
| CSP `wasm-unsafe-eval` | Required to instantiate the bundled Tesseract WebAssembly module on our own extension pages. No remote code: the core, the worker and the language data all ship inside the package under `vendor/tesseract/`, with every path pinned. |

**Single purpose**（不变）：Translate web content — selected text, whole pages,
video subtitles, text inside images, and PDFs — using a translation engine the
user chooses.

**Remote code**：仍然选 **"No, I am not using remote code"**。

**数据用途**：用户文本被发送到用户自己配置的 OpenAI 兼容接口以完成翻译 ——
默认引擎是 Chrome 端上的 Translator，此时文本不出设备；漫画和 PDF 翻译发送到
我方服务器处理。设置页里的「本机统计」（含每日 AI 额度用的「今天花了多少
字符」）只写 `chrome.storage.local`，不同步也不上传，**不是埋点**。不出售数据、不用于与功能无关的用途、不做信用评估。

**Data types 那几个勾，按下面这张表填 —— 别少勾。** 表单问的是「这个扩展收集
什么」，而漫画和 PDF 翻译是账号制的：用了它们，我方服务器上就有邮箱、额度和任务
记录（细账见 [privacy-policy.md](privacy-policy.md) 第二节）。少勾一项，审核对着
登录流程一走就是一次下架级的不实陈述。

| 勾 | 为什么 |
| --- | --- |
| **Personally identifiable information** | 登录后账号里有用户的邮箱（Google / GitHub 在授权时提供），设置页会把它显示出来 |
| **Authentication information** | 登录令牌存在 `chrome.storage.local`，每个请求用它换授权 |
| **Website content** | 要翻译的文本；漫画的图片和 PDF 文件会上传到我方服务器 |
| **User activity** | 任务记录：每个漫画 / PDF 任务存在账号上，跨设备可见 |
| **Web history** | 漫画任务连同图片发送**那张图所在页面的网址**（`pageUrl`）。**只有这一条路**会把网址发给我们 —— 网页翻译、字幕、OCR、自动翻译都不发 |

不勾：Health information、Financial and payment information、Personal
communications、Location。

**Privacy policy URL**：本次**必须**提供。政策正文见
[privacy-policy.md](privacy-policy.md)，发布前把它挂到一个公开 URL 上，并填好
文末的联系邮箱。**它在 1.4.0 这一版被重写过**：第二节新增了账号那一半的细账，
旧版本那句「我们不收集你的任何数据」与登录流程对不上。

## 四、给审核员的测试说明（Reviewer notes）

> Automatic translation is the new feature and the one worth checking. It is on
> by default, and it does nothing at all until it has a reason to.
>
> 1. Install and open a page that is already in the target language (for a
>    machine set to English, `https://en.wikipedia.org/wiki/Chrome_Web_Store`).
>    Nothing happens — the page's language matches the target, so there is
>    nothing to do.
> 2. Open a page in another language
>    (`https://ja.wikipedia.org/wiki/Google_Chrome`). A bar appears at the
>    bottom asking whether to translate this site. **Nothing has been
>    translated and nothing has been sent yet.**
> 3. Tick "Always translate ja.wikipedia.org" on the bar and press
>    "Translate". The page translates, and the bar is gone for good on that
>    site. Press Alt+A to toggle this visit back to the original.
> 4. Open Settings → Automatic Translation. The site you just answered for is
>    listed under "Sites you have decided about", with a button that deletes
>    the rule. Delete it, reload the page, and the bar is back — the decision
>    was fully reversible.
> 5. "On this computer" on the same page shows the counters. They are in
>    `chrome.storage.local` (`shared/auto-stats.js`) and are never uploaded;
>    the Clear button empties them. The translation cache below it has a Clear
>    button of its own, which deletes every cached translation
>    (`shared/translation-cache.js`).
> 6. Open a YouTube video in another language and turn its captions on. The
>    translated line appears under the original — subtitles follow the same
>    site decision as the page: on a site set to never translate ("Auto-
>    translate this site" switched off in the toolbar popup or in the
>    extension's menu inside the player) neither the page nor its subtitles
>    are translated, and that is remembered.
>
> On default settings the translation engine is Chrome's on-device Translator,
> so steps 1–6 send **no text anywhere**. Chrome may download a language pack
> on first use; the Settings page has an explicit button for that.

## 五、提交前 checklist

- [x] `manifest.json` 版本已升到 1.4.0（高于已提交的 1.3.1）
- [x] `permissions` / `host_permissions` 未新增任何项
- [x] `_locales/` 十种语言的 `appDescription` 已重写并全部 ≤132 字符
- [x] `npm run test:unit` 全绿（733 passed）
- [x] `npm run test:e2e` 全绿（229 passed, 9 skipped）
- [ ] `npm run zip` 产物已校验：十种 `_locales` 齐全、Tesseract 核心与语言包在内、
      无 `.DS_Store`、无 source map、无测试文件
- [ ] 在 `chrome://extensions/` 用「加载已解压的扩展程序」实测一遍第四节那六步
- [ ] **隐私政策已挂到公开 URL，文末联系邮箱已填**（表单里必填）
- [ ] 上传 zip、粘贴第二节的更新说明；权限理由按第三节填，`<all_urls>` 那一栏
      用新写的那段，**不要沿用 1.3.0 的答案**

## 六、仍未解决的一点

1.3.0 和 1.3.1 都记过、都没改的那一条，这里第三次记：商店的详细简介里写着
「免费、安全、无中间服务器的 AI 翻译」（英文 `no middleman`），而漫画翻译和
PDF 翻译确实会把文件上传到我方服务器。

**这一版之后它更站不住了**：自动翻译把「默认引擎是端上的、文本不出设备」变成
了一句很有分量的卖点，而同一段文案里那句无条件的 `no middleman` 会把它一起拖
下水 —— 审核员发现一句不实，会连着不信另一句。建议改成有限定的说法：

> 网页翻译默认在你的设备上完成，文本不经过任何中间服务器；漫画与 PDF 翻译需要
> 上传文件到我们的服务器处理。
>
> Web page translation runs on your device by default — no middleman. Comic and
> PDF translation upload the file to our servers to do the work.

这一条改的是商店后台的文案，不在代码库里，所以只能在这里记着。
