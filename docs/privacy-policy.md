# 隐私政策 — 叭叭翻译 / Blab Translation Privacy Policy

最后更新：2026-09-20 ｜ 适用版本：1.4.0 起
Last updated: 2026-09-20 ｜ Applies from: version 1.4.0

> 这一页要能贴到 Chrome 网上应用店的 **Privacy policy URL** 里，所以它写的是
> 事实，不是承诺：每一条都能在源码里指到具体文件。哪天代码改了而这一页没改，
> 那就是这一页错了。

---

## 一句话 / In one sentence

**我们不收集你的任何数据。** 扩展把要翻译的文字发给**你自己配置的**翻译接口；
漫画和 PDF 这两项功能例外，它们会把文件上传到我们的服务器处理。除此之外，没有
任何东西离开你的电脑 —— 没有埋点、没有统计上报、没有第三方分析。

**We collect nothing.** The extension sends the text you want translated to the
API **you configured yourself**. The two exceptions are comic and PDF
translation, which upload the file to our server to do the work. Nothing else
leaves your computer: there is no analytics, no telemetry, no third-party SDK.

---

## 一、文字去了哪里 / Where your text goes

| 功能 | 去向 | 说明 |
| --- | --- | --- |
| 网页翻译（含自动翻译） | **Chrome 内置翻译引擎（默认，完全离线）**，或你在设置里填的 OpenAI 兼容接口 | 默认引擎是 Chrome 端上的 Translator API，译文在你的电脑里算出来，一个字节都不出去。改成 API 引擎后，要翻译的那几段文字会发到**你填的那个地址**，用**你自己的 API key**。我们看不到，也收不到。 |
| 划词 / 悬停 / 输入框翻译 | 同上 | 同一条路，同一个引擎设置。 |
| 视频字幕翻译 | 同上 | 发出去的是字幕文本，不是视频、不是音频。 |
| 图片文字识别（OCR） | **默认在本机**（打包在扩展里的 Tesseract，离线运行）；也可以选用你自己的视觉模型 | 选本机引擎时图片不出电脑。选视觉模型时，图片会发到你填的那个接口。 |
| **漫画翻译** | **我们的服务器**（`blab-translation.com`） | 需要登录。图片上传到我们的服务器处理，处理完返回结果。 |
| **PDF 翻译** | **我们的服务器**（`blab-translation.com`） | 需要登录。整个 PDF 文件会上传。任务在服务器上排队，完成后通知你。 |

**自动翻译不改变这张表。** 它改变的只是「什么时候开始翻译」—— 从「你点一下」
变成「这一页符合你设的规则时自动开始」。发出去的还是同样的文字，发到同样的地方，
用同样的引擎。默认引擎是离线的那个，所以**一台没改过设置的机器上，自动翻译不产生
任何网络请求**。

**Automatic translation does not change that table.** It changes *when*
translation starts — from "you clicked" to "this page matches a rule you set."
The same text goes to the same place through the same engine. The default
engine is the offline one, so on a machine with default settings, automatic
translation makes no network request at all.

---

## 二、存在你电脑上的东西 / What is stored on your machine

| 内容 | 位置 | 跟着账号同步吗 |
| --- | --- | --- |
| 设置（接口地址、模型、目标语言、各种开关） | `chrome.storage.sync` | 是 —— 这是 Chrome 的账号同步，数据在 Google 那里，不经过我们 |
| 站点规则（你对每个网站按下的「总是翻译 / 不再翻译」） | `chrome.storage.sync` | 是，同上 |
| API key | `chrome.storage.sync` | 是，同上。**我们从不读取、不上传它**；它只在你的浏览器里被拼进发给你自己接口的请求 |
| 登录令牌（漫画 / PDF 用） | `chrome.storage.local` | **否**，只在这台设备上 |
| 本机统计（这个月自动翻了几页、缓存省了多少、发出去多少字符） | `chrome.storage.local` | **否，而且从不上传**。见 `shared/auto-stats.js` |
| 译文缓存 | `chrome.storage.local` | 否 |

**「本机统计」那一块是给你自己看的镜子，不是我们的埋点。** 它之所以放在
`local` 而不是 `sync`，正是为了这句话能站得住：`sync` 跟着账号走，这几个数字不
该跟着走。设置页里有一颗「清除」按钮，按下去就没了。

The stats panel is a mirror for you, not telemetry for us. It is in `local`
rather than `sync` precisely so that claim holds, and the settings page has a
button that clears it.

---

## 三、权限为什么要 / Why each permission

| 权限 | 用途 |
| --- | --- |
| `<all_urls>` | 扩展的功能就是翻译你正在看的那一页，而那可以是任何一页 |
| `storage` | 存上面那张表里的东西 |
| `activeTab` | 你从工具栏或右键菜单发起的那一次翻译 |
| `contextMenus` | 右键菜单里的那几条 |
| `identity` | 漫画 / PDF 的登录流程 |
| `notifications` | PDF 在服务器上跑完时告诉你 |
| `alarms` | 每分钟查一次 PDF 任务状态（MV3 的 service worker 不能长期挂定时器） |
| `offscreen` | 跑本机 OCR 引擎（它需要 Web Worker 和 WebAssembly，service worker 里跑不了） |

---

## 四、我们不做的事 / What we do not do

- 不出售数据，不把数据用于与功能无关的任何用途，不做信用评估或贷款审批。
- 不收集浏览历史。扩展知道你打开了哪一页，**是因为它要在那一页上干活**，这件事
  不会被记录，也不会被发送 —— 唯一的例外是你自己按下的「总是翻译 / 不再翻译」，
  那条规则存在你的浏览器里。
- 不使用任何第三方分析 SDK。整个代码库里搜不到一个。
- 不下载或执行远程代码。所有 JS 和 WASM 都在安装包里。

---

## 五、删除你的数据 / Deleting your data

- 设置、站点规则、缓存、统计：在设置页里逐项清除，或者直接卸载扩展 —— Chrome
  会把这个扩展的 `storage` 一并删掉。
- 漫画 / PDF 服务器上的数据：在设置页退出登录，或联系下面的邮箱要求删除账号。

---

## 六、联系 / Contact

有任何问题，或者要求删除服务器上的数据：**（发布前填入联系邮箱）**

> ⚠️ 这一行是**唯一一处没法从源码里查出来的内容**，必须由发布者填。Chrome 网上
> 应用店的审核会点这个 URL，留着占位符提交等于自找一轮退回。
