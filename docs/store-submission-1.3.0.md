# Chrome 网上应用店提交说明 — v1.3.0

提交日期：2026-08-16 ｜ 上一个上架版本：1.2.0（2026-08-10）

本文档记录的是 **1.3.0** 那次提交。issue #71 的网页翻译位置修复没有赶上这个包，
随 1.3.1 发布，见 [store-submission-1.3.1.md](store-submission-1.3.1.md)。

## 一、包信息

| 项 | 值 |
| --- | --- |
| 上传文件 | `ai-translator-1.3.0.zip` |
| 大小 | 9.1 MB（解压后约 17 MB，其中 16 MB 是本地 OCR 语言包） |
| 文件数 | 96 |
| manifest 版本 | 3 |
| 扩展版本 | 1.3.0 |
| 最低 Chrome 版本 | 116 |

已核对：manifest 里引用的每个脚本/样式/图标、以及 4 个扩展页面
（`popup`、`options`、`pdf/upload`、`offscreen`）里引用的每个资源，都在包内；
无 `.DS_Store`、无 source map、无测试或 `node_modules` 文件；10 种语言的
`_locales` 齐全。

## 二、本次更新说明（可直接粘贴）

**中文**

> 1.3.0
> - 新增图片文字识别（OCR）：右键图片即可读出其中的文字，也可以框选图片的某个
>   区域只识别那一块。默认在本地离线运行，不需要 API Key、不上传图片；也可以
>   改用你自己的视觉模型。识别与翻译是两步，识别完先给你原文，要不要翻译由你
>   点一下决定。
> - 修复：使用 Chrome 内置翻译引擎（默认引擎）时，译文中的超链接会全部丢失。
> - 修复：在按坐标定位的页面上，译文会盖住原有内容。现在优先让原文让位，实在
>   放不下才不显示译文。
> - 修复：PDF 翻译遇到一次临时失败后，24 小时内无法再次使用。
> - 修复：部分网站的主题样式会影响插件面板内按钮的外观。

**English**

> 1.3.0
> - New: image OCR. Right-click an image to read the text in it, or select a
>   region to read just that part. Runs on-device by default — no API key, no
>   upload; your own vision model is an alternative. Recognition and
>   translation are separate steps: you get the recognised text first and
>   choose whether to translate it.
> - Fixed: hyperlinks were lost from translations on Chrome's built-in
>   translation engine (the default engine).
> - Fixed: on coordinate-driven layouts, translations could overlap existing
>   content. The source line now yields first; the translation is only dropped
>   as a last resort.
> - Fixed: one transient failure disabled PDF translation for 24 hours.
> - Fixed: some sites' theme CSS could restyle buttons inside our panels.

完整技术记录见 [CHANGELOG.md](../CHANGELOG.md) 的 1.3.0 一节。

## 三、权限理由（Privacy practices 表单逐条填写）

**本次相对 1.2.0 新增的只有 `offscreen` 一项，以及扩展页面 CSP 里的
`wasm-unsafe-eval`** —— 这两项都只为本地 OCR 引擎服务，是审核最可能追问的点。

| 权限 | 理由（可直接粘贴） |
| --- | --- |
| `offscreen` 🆕 | Runs the bundled Tesseract OCR engine, which needs a Web Worker and WebAssembly. An MV3 service worker cannot spawn a nested Worker or instantiate this WASM, so an offscreen document is the only place this engine can run. It is created on demand for a recognition request and closed afterwards. |
| CSP `wasm-unsafe-eval` 🆕 | Required to instantiate the bundled Tesseract WebAssembly module on our own extension pages. No remote code is involved — the core, the worker and the language data all ship inside the package under `vendor/tesseract/`, and every path is pinned so the library's CDN defaults are never used. |
| `storage` | Stores the user's own settings (API endpoint, model, target language, feature toggles) and the sign-in token. |
| `activeTab` | Runs a translation on the tab the user explicitly acted on (toolbar button or context menu). |
| `contextMenus` | The right-click entries for translating a selection/page and for recognising text in an image. |
| `identity` | `chrome.identity.getRedirectURL()` / web auth flow for signing in to the optional account used by comic and PDF translation. |
| `notifications` | Server-side PDF translation outlives the page that started it; the notification tells the user when the job finished or failed. |
| `alarms` | Polls that PDF job's status once a minute — an MV3 service worker cannot hold a long-lived timer. |
| `<all_urls>` | The extension's single purpose is translating the page the user is on, and that can be any page. Content scripts only translate when the user asks; no page content is read or sent otherwise. |

**Single purpose**（如需重填）：Translate web content — selected text, whole
pages, video subtitles, text inside images, and PDFs — using a translation
engine the user chooses.

**Remote code**：选 **"No, I am not using remote code"**。所有 JS/WASM 都在包
内；扩展只通过网络传输数据（翻译请求/响应），不下载或执行远程代码。

**数据用途**：用户文本被发送到用户自己配置的 OpenAI 兼容接口以完成翻译；漫画和
PDF 翻译发送到我方服务器处理。不出售数据、不用于与功能无关的用途、不做信用评估。

## 四、给审核员的测试说明（Reviewer notes，建议填写）

不需要账号即可验证的功能（本次更新的主体）：

1. 图片 OCR（本地引擎，无需任何配置）：在任意网页右键一张含文字的图片 →
   "识别图片中的文字"。首次会加载本地语言包，随后弹窗显示识别出的文字，
   点击弹窗中的"翻译"按钮才会进行翻译。
2. 区域 OCR：右键图片 → "识别选定区域的文字"，在图片上拖出一个矩形。
3. 网页翻译：点击工具栏图标 → 翻译此页面（默认使用 Chrome 内置翻译引擎，
   无需 API Key）。

需要账号的功能（**非本次更新内容**，1.1.1/1.2.0 已上架）：漫画翻译、PDF 翻译
运行在我方服务器上，需登录后使用每月免费额度。若审核需要，请提供测试账号。

## 五、提交前 checklist

- [x] `manifest.json` 版本已升到 1.3.0（高于已上架的 1.2.0）
- [x] `npm run test:unit` 全绿（284 passed）
- [x] `npm run zip` 产物完整性已校验（引用无缺失、无多余文件）
- [x] CHANGELOG 1.3.0 一节已写（并把此前误记在 1.2.0 下的 OCR 条目移到了这里
      —— 8/10 上架的 1.2.0 包里并不含 OCR）
- [x] `npm run test:e2e` 整轮复跑 138 passed / 9 skipped / 0 failed。
      （第一轮曾有 1 条 `comic-account.spec.js` 的 60s 超时。当时判为偶发；后来
      查明是 mock server 拆卸时挂住，已由 `e00bcb7` 修掉。）
- [ ] 在 `chrome://extensions/` 用"加载已解压的扩展程序"实测一遍 1.3.0 的
      OCR 与网页翻译
- [ ] 上传 zip、粘贴上面的更新说明与权限理由、提交审核

## 六、一个需要你确认的点

商店的简介文案是"免费、安全、无中间服务器的 AI 翻译"（英文 `no middleman`），
而漫画翻译和 PDF 翻译确实会把文件上传到我方服务器处理。这两句话放在一起，审核
方在核对数据用途声明时可能会认为描述与实际不符。建议把简介改成类似"网页翻译不
经过中间服务器"的限定说法，或在详细说明里写清楚哪些功能会上传文件。这次可以先
提交，但迟早要对齐。
