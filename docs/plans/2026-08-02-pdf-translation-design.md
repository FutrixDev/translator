# PDF Translation — Research & Design

**日期**: 2026-08-02
**状态**: 调研记录（保留存档）。方向已定稿：**直接采用服务端重排渲染**（本文 §5 的 M3）作为唯一产品形态，不做 M0–M2 客户端路线。定稿设计见 translator-site 私有仓库 `docs/plans/2026-08-02-pdf-translation-server-retypeset-design.md`。

**Goal**
很多论文只有 PDF 没有 HTML 版本，现有的整页翻译管线（DOM 驱动）对 PDF 完全失效。本文调研业界实现方式，并给出在本扩展（MV3、无构建步骤、纯客户端 vanilla JS）中支持 PDF 翻译的分阶段设计。

---

## 1. 硬约束：Chrome 内置 PDF 查看器碰不到

Chrome 用一个内部组件扩展（`mhjfbmdgcfjbbpaeojofohoefgiehjai`，MimeHandlerView + OOPIF）渲染 PDF，内容在跨源、跨进程 frame 里并被 closed shadow DOM 包裹 —— Chromium 明确是为了"阻止脚本访问 PDF viewer 的内部 frame"。我们的 content script 注入到 PDF 标签页后只能看到一个 `<embed>`：

- 拿不到任何文本 DOM；
- 收不到插件 frame 内的选区事件；
- 无法 postMessage 与全页 PDF viewer 通信。

**结论：不存在"翻译内置查看器"这条路。要么用自己的查看器接管渲染（PDF.js），要么把文件字节上传服务端。**

## 2. 业界方案调研

### 2.1 沉浸式翻译（Immersive Translate）—— 双层策略
- **免费模式 = 客户端 PDF.js 查看器**：扩展内置 viewer 页，canvas 渲染原文 + 文本层，把文本层 span 合并成段落猜测，在原文附近注入双语文本块。导出靠浏览器打印。官方文档明确只支持"标准（非扫描）PDF"，多栏排版效果差 —— 差就差在段落重建启发式。
- **PDF Pro = 服务端重排**：上传后服务端做版面分析、公式/表格识别、扫描件 OCR、多栏转单栏、段落对齐双语输出。其引擎已开源为 **BabelDOC**（funstory-ai 即沉浸式翻译公司）：DocLayout-YOLO 版面检测 → 坐标锚定文本抽取 → LLM 翻译 → 重排生成新 PDF。
- 入口设计：**默认不自动劫持 PDF**。在线 PDF 点扩展图标手动触发；本地 PDF 走 viewer 里的上传按钮（免"允许访问文件网址"授权）。

### 2.2 PDF.js 官方 Chromium 扩展 —— MV3 拦截的标准答案
Mozilla 2024-09 已把官方扩展迁到 MV3（PR #18681），其 `extensions/chromium/pdfHandler.js` 就是照抄蓝本：
- **主路径：`declarativeNetRequest` + `responseHeaders` 匹配条件**（Chrome 128+）：匹配 `Content-Type: application/pdf`、`Content-Disposition` 文件名、`.pdf` URL 后缀、以及实为 PDF 的 `application/octet-stream`，redirect 到扩展内 viewer 页。Chrome 121–127 会忽略该条件，需 feature-detect。
- **`file://` 不触发 DNR**：回退 `chrome.webNavigation.onBeforeNavigate` + `chrome.tabs.update`，且要求用户手动开"允许访问文件网址"（可用 `chrome.extension.isAllowedFileSchemeAccess()` 检测）。最友好的兜底是 viewer 页里放一个本地文件上传按钮（`<input type=file>` → `getDocument(arrayBuffer)`），零授权。
- viewer 页必须列入 `web_accessible_resources`；远程 PDF 字节在扩展页 fetch（有 `<all_urls>` host permission 即可绕 CORS），失败再经 background 代理。
- 打包注意：现代 pdf.js 用 WASM（openjpeg/qcms），需要 `content_security_policy.extension_pages` 加 `'wasm-unsafe-eval'`（无远程代码，商店合规）。体积 pdf.mjs + worker 约 4–5 MB，CJK 字体/cmaps 再约 5 MB。pdf.js 是 ESM、可免构建直接用，契合本项目。

### 2.3 PDFMathTranslate / pdf2zh / BabelDOC —— 服务端重排系
pdfminer.six 解析 + DocLayout-YOLO（ONNX）版面检测，公式/图表识别后用 `{v1}` 占位符保护、译后还原，PyMuPDF 重排出译文/双语 PDF。**全 Python + 视觉模型，无法客户端化**（无 WASM/JS 移植；理论上 onnxruntime-web + 20MB 模型 + JS 重排引擎，远超本项目形态）。现实用法：留一个"自托管 pdf2zh/BabelDOC 端点"的集成口，或走我们已有的漫画 SaaS 模式做付费档。

### 2.4 其他参考
- **MouseTooltipTranslator**（开源 MV3）：PDF URL 重定向到内置 PDF.js 页，文本层上做悬停翻译。选 PDF.js 的理由与我们一致。
- **Zotero PDF Translate**：不做全文，只挂 PDF.js 阅读器的**选区事件**做划词翻译。启示：拥有 viewer 后，划词翻译几乎白送，适合做第一个里程碑。
- **DeepL / Google 文档翻译**：纯服务端上传→回吐译文文件，验证了"重排档"的市场存在。
- **arXiv HTML**：2023-12 起 arXiv 为 TeX 投稿生成 HTML（`arxiv.org/html/<id>`），老论文有 ar5iv。检测 `arxiv.org/(abs|pdf)/<id>` 并引导"打开 HTML 版翻译"，就能把最难的数学论文转回我们已经跑通的 HTML 管线，成本约 30 行。

## 3. 段落重建 —— 真正的核心工作量

PDF 没有段落概念。`page.getTextContent()` 返回的 TextItem 带 `str/transform/width/height/fontName/hasEOL`，但是**内容流顺序而非阅读顺序**，且切分不稳定（可能按词甚至字形段切）。所有客户端实现都在做同一套启发式：

1. **规整**：丢空项，从 transform/width/height 算 bbox，推字号。
2. **行聚类**：基线 y 差 < ~0.3–0.5 × 字号的项归为一行，行内按 x 排序（`hasEOL` 只能当辅助信号）。
3. **分栏检测**：按行起点 x 聚类 / 找纵向空白带，把行分配到栏，栏间从左到右读（双栏论文正确性的关键，也是沉浸式免费版翻车、Pro 版修好的点）。
4. **段落切分**：栏内满足任一即断段 —— 行距 > ~1.5 × 中位行高；首行缩进变化；上一行明显偏短（< ~80% 栏宽）且以句末标点结尾；字号/字体变化（标题边界）；行尾连字符做拼词合并。
5. **哨兵占位**：上下标、行内公式碎片（小字号、基线异常）转成行内占位符，译后还原 —— 与现有 `{{n}}` 数学占位符机制同构，可直接复用其校验逻辑（`keepsPlaceholders`）。
6. 保留 item→段落映射，译文按源行 bbox 定位回填。

捷径与替代：
- **tagged PDF**：`page.getStructTree()` 直接给出真段落结构，作为机会性 fast path（arXiv/扫描件大多没有）。
- **mupdf.js**（WASM，`toStructuredText()` 自带块/行分组）：效果更好但 ~10 MB 且 **AGPL**，许可上不适合本仓库，不采用。
- 没有现成小型 MIT JS 库能把分栏+分段做好 —— **这段启发式就是本功能的差异化代码**。

## 4. 候选架构对比

| | A. PDF.js 接管 + 文本层双语注入 | B. 服务端重排（BabelDOC 系） | C. arXiv HTML 回退 | D. 纯文本抽取 |
|---|---|---|---|---|
| 契合"客户端、免构建、vanilla JS" | ✅（pdf.js 为 ESM） | ❌（Python + YOLO 服务） | ✅ | ✅ |
| 版面保真 | 高（原 canvas 保留） | 最高（真双语 PDF） | 高（语义 HTML） | 无 |
| 双栏论文 | 需分栏启发式 | 版面模型解决 | HTML 天然解决 | 差 |
| 扫描件 | ❌ | ✅（OCR） | N/A | ❌ |
| 双语导出 | 浏览器打印 viewer | 原生 PDF 输出 | 打印页面 | 复制文本 |
| 工作量 | 中高（viewer + 段落引擎） | 高 + 基础设施 | 极小 | 低 |
| 先例 | 沉浸式免费版、MouseTooltipTranslator | 沉浸式 PDF Pro、DeepL | — | 早期工具 |

**推荐**：C 立即做，A 作为核心功能分两步做（划词 → 全文双语），B 记为远期集成点（自托管 pdf2zh 端点，或复用漫画 SaaS 的 auth/计费/轮询/幂等全套模式做付费档），不在本期实现。

## 5. 推荐方案：分阶段设计

### M0 — arXiv HTML 引导（~30 行，独立可先发）
content script 检测 `arxiv.org/abs|pdf/<id>`，页面顶部出条横幅："该论文有 HTML 版，打开并翻译"→ 跳 `arxiv.org/html/<id>`（404 时试 ar5iv），落地后自动触发现有整页翻译。数学论文是 PDF 翻译最难的场景，这条捷径直接把它们转回已跑通的管线。

### M1 — PDF.js 查看器 + 划词/悬停翻译
新增 `pdf/` 目录：
- `pdf/viewer.html` + `pdf/viewer.js`：精简版 PDF.js viewer（canvas + 文本层 + 翻页/缩放），带"打开本地 PDF"上传按钮。
- `pdf/pdf.mjs`、`pdf/pdf.worker.mjs`（+ 按需 cmaps）：vendored pdf.js。
- 拦截（照抄官方 pdfHandler.js）：background 注册 DNR responseHeaders redirect 规则（Chrome 128+ feature-detect），`file://` 走 webNavigation 回退；**默认关闭**，Options 加 `enablePdfTranslation` 开关（对齐沉浸式的克制策略，避免劫持用户默认阅读体验）。
- viewer 页直接加载现有 content script 家族（它是扩展页，可以正常 `<script>` 引入 `content-*.js`），于是**划词翻译、悬浮球、`ctx.requestTranslation`（内置引擎 + AI 回退）全部白送** —— 这就是 Zotero 模式。

manifest 变更：`web_accessible_resources: [pdf/viewer.html]`、`declarativeNetRequest` + `webNavigation` 权限、CSP `extension_pages` 加 `'wasm-unsafe-eval'`。

### M2 — 全文双语翻译（核心）
新增 `content/content-pdf-translation.js`（或 viewer 专属模块）：
1. 逐页 `getTextContent()`（先试 `getStructTree()` fast path）→ §3 段落重建 → 产出 `{paragraphs: [{text, items, bbox}]}`。
2. 复用现有管线：`createSmartBatches` + `runWithConcurrency` + `TRANSLATE_BATCH_FAST`（delimiter 协议，background **零改动**）+ `shouldSkipTranslation` + `filterBlocksByLanguage` + `#ai-translator-progress` 进度条。
3. 行内公式碎片 → `{{n}}` 占位符，复用 `keepsPlaceholders` 校验与还原逻辑。
4. **译文呈现：段落 bbox 下方注入双语块**（文本层同级的绝对定位 div，样式对齐 `.ai-translator-inline-block`），原 canvas 不动 —— 版面保真免费。页面按需翻译（当前页 ± 预取窗口，参考 YouTube 字幕的 rolling window 思路），不是一次性全文档。
5. 导出：v1 用浏览器打印（沉浸式免费版同款），真双语 PDF 留给 M3。

### M3（远期，可选）— 服务端重排档
两个方向择一：Options 里允许配置自托管 pdf2zh/BabelDOC 端点；或按 `comic-client.js` 模式（Bearer token、幂等 operationId、字节直传 ≤10MB、轮询 + 跨页恢复）在 translators-ai.com 加 PDF 重排 API。解决扫描件（OCR）与原生双语 PDF 导出。本期只留接口，不实现。

## 6. 复用与新增清单

**直接复用（零改动或近零改动）**：`ctx.requestTranslation`、数学占位符往返（`getTextWithMathPlaceholders` 思路 / `buildTranslationContentWithMath` / `splitTextIntoChunks`）、`createSmartBatches` + 并发池 + `MAX_BATCH_FAILURES` 策略、`shouldSkipTranslation` / 语言预过滤、进度条 UI、`ctx.*` 模块注册约定、background 的 `TRANSLATE_BATCH_FAST` 契约、i18n 结构。

**需要新写**：PDF 拦截与 viewer 页；段落重建引擎（行聚类/分栏/分段，≈本功能 60% 的工作量与风险）；文本层双语注入渲染；`enablePdfTranslation` 设置 + 各语言 i18n 文案；入口（popup 行、悬浮球菜单项、右键菜单 `translate-pdf`）。

## 7. 风险与限制

| 风险 | 说明 / 缓解 |
|---|---|
| 扫描件 PDF | 客户端无 OCR，明确提示不支持，指向 M3 |
| 多栏/复杂版面误判 | 启发式必有 badcase；断段错误的代价只是"译文块位置/粒度不佳"，原文 canvas 永远完好 |
| 体积 +5–10 MB | 当前扩展 ~111KB；pdf.js 不可避免，cmaps 可按需懒加载 |
| Chrome < 128 | DNR responseHeaders 不可用 → 只留手动入口（点图标"翻译此 PDF"） |
| file:// 授权摩擦 | 上传按钮兜底，零授权可用 |
| 劫持感 | 默认关闭自动接管；开启后 viewer 页顶部留"用系统查看器打开"逃生口 |
| CWS 审核 | WASM 属打包资源非远程代码，合规；CSP 变更写清 changelog |

## 8. 测试策略（对齐现有 e2e 三形态）

1. **纯 DOM 单测形态**（最便宜，仿 `table-translation.spec.js`）：把段落重建函数暴露在 ctx 上，用手工构造的 TextItem 数组（单栏/双栏/带公式碎片/连字符断行）断言分段结果 —— 不需要真 PDF 渲染。
2. **mock-OpenAI 全链路形态**（仿 `page-translation-highlight-class.spec.js`）：Playwright 打开 `chrome-extension://<id>/pdf/viewer.html?file=<fixture.pdf>`，走 mock server（沿用从 system prompt 反解 delimiter 的防漂移 mock），断言双语块出现。fixture 用脚本生成的最小 PDF（可用 pdf-lib devDependency 或预生成的静态 fixture）。
3. 拦截规则：e2e 起本地 http server 回 `application/pdf`，断言跳转到 viewer 页。

## 9. Non-Goals（本期）

- 扫描件 OCR、原生双语 PDF 导出、译文替换原文的重排模式（均属 M3/服务端档）。
- Firefox/Safari 适配。
- PDF 注释、表单等 viewer 完整功能 —— viewer 只服务阅读 + 翻译。

## 参考

- pdf.js MV3 扩展与拦截蓝本: https://github.com/mozilla/pdf.js/pull/18681 · `extensions/chromium/pdfHandler.js`
- Chromium 关闭 PDF viewer 内部 frame 的提交: https://chromium.googlesource.com/chromium/src/+/b6fac0aabc07e59a203b1b02cc4d615ac0e9084e
- declarativeNetRequest responseHeaders (Chrome 128+): https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest
- 沉浸式翻译 PDF 文档: https://immersivetranslate.com/en/docs/features/pdf/ · BabelDOC: https://github.com/funstory-ai/BabelDOC
- PDFMathTranslate: https://github.com/PDFMathTranslate/PDFMathTranslate · 论文: https://arxiv.org/html/2507.03009v2
- pdf.js TextItem 顺序/切分问题: mozilla/pdf.js#17191, #18201
- MouseTooltipTranslator: https://github.com/ttop32/MouseTooltipTranslator · zotero-pdf-translate: https://github.com/windingwind/zotero-pdf-translate
- arXiv HTML: https://blog.arxiv.org/2023/12/21/accessibility-update-arxiv-now-offers-papers-in-html-format/ · ar5iv: https://ar5iv.labs.arxiv.org/
