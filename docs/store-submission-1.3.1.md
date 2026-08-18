# Chrome 网上应用店提交说明 — v1.3.1

提交日期：2026-08-18 ｜ 上一个上架版本：1.3.0（2026-08-16 提交）

补丁版本，只修 bug：没有新功能、没有新权限、没有新的数据用途。权限理由表单与
1.3.0 完全一致，见 [store-submission-1.3.0.md](store-submission-1.3.0.md) 第三节，
逐条照填即可。

## 一、包信息

| 项 | 值 |
| --- | --- |
| 上传文件 | `ai-translator-1.3.1.zip` |
| 大小 | 9.1 MB（解压后约 17 MB，其中 16 MB 是本地 OCR 语言包） |
| 文件数 | 96 |
| manifest 版本 | 3 |
| 扩展版本 | 1.3.1 |
| 最低 Chrome 版本 | 116 |
| 打包源 | `main` @ PR #72 合并之后 |

与 1.3.0 的包相比，文件清单完全相同，只有三个内容脚本和版本号变了：
`content/content-page-translation.js`、`content/content-hover-translation.js`、
`content/content.css`。

## 二、本次更新说明（可直接粘贴）

**中文**

> 1.3.1
> - 修复：整段文字有时不会被翻译。一个段落里只要混有子元素（比如加粗、链接后面
>   还跟着一个小段落），段落自己的正文就会被整段漏掉。
> - 修复：译文出现的位置。带底色的方框（例如文档站的对话框、代码框）里，译文会
>   掉到框的外面变成一段裸文字；列表项的译文会跑到整个列表的左侧，既没有项目
>   符号，也不跟原条目对齐。现在这两种情况下译文都插在原文块内部，保持页面原有
>   的边框、底色和缩进。
> - 修复：页面用负边距把相邻两行吸到一起时，译文会和原文叠在一起。

**English**

> 1.3.1
> - Fixed: a paragraph's own text could go untranslated. Whenever a paragraph
>   also contained a child element, the paragraph's own sentences were skipped
>   entirely.
> - Fixed: where translations are placed. Inside a shaded box (a documentation
>   site's dialogue or code box) the translation rendered outside the box as
>   bare text; a list item's translation sat to the left of the whole list with
>   no bullet and no matching indent. Both now render inside the source block,
>   keeping the page's own border, background and indentation.
> - Fixed: on pages that pull adjacent lines together with negative margins,
>   the translation could overlap the original text.

完整技术记录见 [CHANGELOG.md](../CHANGELOG.md) 的 1.3.1 一节。

## 三、给审核员的测试说明（Reviewer notes）

本次改动只影响网页翻译时译文插入 DOM 的位置，不涉及网络请求、权限或数据处理。
可复现页面：`https://alignment.anthropic.com/2026/psm/`，对整页执行翻译，观察
带底色的对话框与项目符号列表——1.3.0 上译文会掉到框外、列表译文没有项目符号，
1.3.1 上两者都在原文块内部。

## 四、提交前 checklist

- [x] `manifest.json` 版本已升到 1.3.1（高于已提交的 1.3.0）
- [x] `npm run test:unit` 全绿（301 passed）
- [x] `npm run test:e2e` 139 passed / 9 skipped / 0 failed
- [x] `npm run zip` 产物已校验：96 个文件、10 种 `_locales` 齐全、Tesseract 核心
      与 5 个语言包在内、无 `.DS_Store`、无 source map、无测试文件
- [ ] 在 `chrome://extensions/` 用"加载已解压的扩展程序"实测一遍网页翻译
- [ ] 上传 zip、粘贴上面的更新说明；权限理由沿用 1.3.0 的答案

## 五、仍未解决的一点

商店简介文案是"免费、安全、无中间服务器的 AI 翻译"（英文 `no middleman`），而
漫画翻译和 PDF 翻译确实会把文件上传到我方服务器处理。1.3.0 提交时就记过这一条，
仍然没改。建议改成"网页翻译不经过中间服务器"这种限定说法，或在详细说明里写清楚
哪些功能会上传文件。
