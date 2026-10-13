# Chrome 网上应用店提交说明 — v1.5.1

提交日期：2026-10-13 ｜ 上一个提交版本：1.5.0（2026-10-07，商店 10-08 上线）

这一版**代码与 1.5.0 逐字节相同**，只改商店能被搜到的文字：扩展名、简短说明、
详细说明。打包源是 1.5.0 实际上架的那份代码（`57880d9`，与已上架 zip 逐文件
比对 228/228 一致），不是 `main` —— `main` 上 1.5.0 之后合入的 #149–#153
（Blab 内置引擎等）不在这一版里。

## 为什么改

2026-10-12 实测商店英文搜索（crawl-store，tag `cws-seo`）：

| 搜索词 | Blab 的位置 |
| --- | --- |
| Blab Translation | 第 1 |
| bilingual pdf epub word（冷门词） | 第 3（共 3 个结果） |
| pdf translation / translate pdf | 前 10 没有 |
| ai translation | 前 10 没有 |
| manga translation / comics translation | 前 10 没有 |
| dual youtube subtitles | 前 10 没有 |

说明文字是被索引的（冷门词能搜到），但热门词的前 10 名**几乎全把搜索词写在
扩展名里**（「… AI Web, PDF & Video Translator」「… Manga Translator」）。
我们的扩展名只有品牌「Blab Translation」，十种语言的说明里也一次都没有
manga、AI translator、PDF translation 这几个原词。另一半原因是装机量（当时
48 用户、1 条评分），文字只能解决前一半。

## 一、包信息

| 项 | 值 |
| --- | --- |
| 上传文件 | `blab-translation-1.5.1.zip`（`npm run zip` 产物，仓库里不跟踪 zip） |
| 扩展版本 | 1.5.1 |
| 打包源 | 分支 `release/1.5.1`（基于 `57880d9`） |
| 新增权限 / host_permissions / CSP 变化 | **无** |

相对 1.5.0，包里只改了 `manifest.json` 的版本号和 `_locales/*/messages.json` 的
`appName`、`appDescription` 两个键。设置页、弹窗里显示的名字读的是
`i18n/messages.js`，不受影响；改名出现在商店、`chrome://extensions`、工具栏
悬停提示，以及右键菜单里多项并列时 Chrome 自动生成的那一级（标题用扩展名）。

## 二、扩展名与简短说明（在包里）

| 语言 | 扩展名（≤75） | 简短说明（≤132） |
| --- | --- | --- |
| en | Blab Translation: AI Translator for Web, PDF & Manga（52） | AI translator: free bilingual web pages, PDF translation that keeps layout, manga translation, dual YouTube subtitles, EPUB/Word.（129） |
| zh_CN | 叭叭翻译：AI 翻译网页、PDF 与漫画 | AI 翻译：免费的双语对照网页，保留排版的 PDF 翻译，漫画翻译，YouTube 双语字幕，EPUB/Word。 |

其余八种语言都是 en 的翻译，关键词用各语言用户实际会搜的说法（KI-Übersetzer、
traducteur IA、ИИ-переводчик、AI翻訳、AI 번역……），拉丁语种都 ≤132 字符
（fr 正好 132）。

写法守 1.5.0 两次被警告定下的规矩：

- 每个关键词只出现一次，不成串罗列品牌、服务商、网站名；不写任何竞品名。
- 只写代码做得到的：漫画只写 manga / comics。**不写 webtoon、manhwa** ——
  长条漫画在 `content/comic/prompts.js` 里会报 `webtoon_strip` 不支持。
- 「免费」只修饰网页翻译（默认端侧翻译确实免费），不修饰 AI 或 PDF。
- 简短说明去掉了「Bring your own AI model」，这一点在详细说明第二段里仍在。

## 三、商店详细说明（后台粘贴）

十个语言区域的说明都在 [`docs/store-listing/<locale>.txt`](store-listing/)，
**十个都要重新整份粘贴**。这次的改动（先改 en，九份逐段同步）：

- 第二段「videos and comics」→「videos, manga and comics」（ja / ko / zh 原文的
  マンガ / 만화 / 漫画 已同时指漫画和 manga，不改）；
- 「PDFS THAT KEEP THEIR LAYOUT」→「PDF TRANSLATION THAT KEEPS THE LAYOUT」；
- 「COMICS & IMAGES」→「MANGA, COMICS & IMAGES」，第一条写「Manga and comic
  pages redrawn …」。

**另一个必须整份粘贴的理由：** 10-12 抓到的线上 en 说明还是更早的稿子
（「Bring the AI you trust local models」漏了「cloud or」，「Rules sync with
your account」没写 browser），和 #145 定稿不一致。照仓库文件整份覆盖即可。

## 四、更新说明（可直接粘贴）

**中文**

> 1.5.1
> - 商店名称与说明更新，功能与 1.5.0 相同。

**English**

> 1.5.1
> - Store name and description updated; features are the same as 1.5.0.

## 五、权限理由与审核员说明

全部沿用 [store-submission-1.5.0.md](store-submission-1.5.0.md) 第四、五节，
原样不动。

## 六、提交前 checklist

- [x] `manifest.json` 版本升到 1.5.1
- [x] `permissions` / `host_permissions` / CSP 未改动
- [x] 十种语言 `appName` ≤75、`appDescription` ≤132 字符
- [x] `npm run test:unit` 全绿
- [x] `npm run zip` 产物与 1.5.0 上架包相比只差 `manifest.json` 与十个
      `_locales/*/messages.json`
- [ ] 上传 zip；十个语言区域的「说明」整份换成 `docs/store-listing/<locale>.txt`；
      更新说明贴第四节
- [ ] **后台隐私政策链接改成 `https://blab-translation.com/app/legal/privacy`**
      —— 10-12 线上详情页显示的还是旧域名 `translators-ai.com/zh/legal/privacy/`
- [ ] 上架后一周复测第「为什么改」一节的六个搜索词
