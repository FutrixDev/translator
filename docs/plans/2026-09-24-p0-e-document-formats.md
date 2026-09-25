# P0-E 插件接六种文档格式：上传、确认、取结果 — 设计

基线：origin/main 78c7cd2（#104 的 squash，与 `feat/p0-a` 头 e8720a4 同树，下文 file:line 都成立）。P0-C 以替代 PR 从 `feat/p0-c` 对 main 并行在审；两者谁后合，谁 rebase 解冲突（§8.2、§8.3）。
主控：P0 回合主控（Opus 5.5）。实现：dev-opus-high。服务端 translator-saas origin/main=baab9eda，只读，不改。

## 0. 结论

- 上传页接六种格式：pdf、docx、epub、mobi（含 `.azw3`）、txt、md（含 `.markdown`）。格式表、MIME、上限、嗅探、状态谓词收进新的双模模块 `shared/doc-jobs.js`（`globalThis.DocJobs`），它是这些事实在扩展里的**唯一出处**。上限按 saas `env.ts` 核实：PDF 30 MiB，docx/epub/mobi 50 MiB，txt/md 10 MiB。
- **传输改道**：SW 只负责领票（新消息 `PDF_UPLOAD_TICKET`）。**页面自己用 XHR 把 File PUT 到预签名地址**，按格式带 content-type，并显示上传进度。之后页面请 SW 建作业（`PDF_CREATE_JOB`，`source.kind:'uploaded'`）。文档路径不再有 base64，也不再把整本文件塞进一条消息（50 MiB 的 base64 已超过 64 MiB 的消息上限）。URL 路径（打开的 PDF 标签页、右键）仍只接 PDF，照旧由 SW 取文件、PUT。
- **本地先拒**：五种情况在页面上直接拒，零网络请求：未知类型、空文件、超上限、前 68 字节嗅探不符、流式文档本地计量超过 800 标准页。
- **流式文档本地计量**（docx、epub、txt、md）：逐行移植 saas CLI 的计量（`packages/cli/src/measure/`），建作业时作为 `declaredUnits` 一起报。不报的话，服务端按 1 页预留，实测一超 20% 就停下来等确认，几乎每本书都要多点一次。PDF 和 MOBI 不报。
- **超页确认（`awaiting_confirm`）第一次被当成一个状态**。现有七处缺陷都把它当成「已结束」或「失败」（§5.1），一并修掉：
  - 作业页出确认面板，列出实测页数、预留页数、追加页数和到期时间；「继续」走新消息 `PDF_JOB_CONFIRM`；
  - popup 和设置页给「查看」入口；
  - 轮询发现作业进入待确认时，发一条常驻通知。
- **结果按格式取**：
  - PDF：仍直接打开结果 PDF；
  - docx、epub、txt、md：在作业页「保存」成文件（blob + `<a download>`，不加 downloads 权限）；
  - MOBI：没有回写文件，只给网页阅读台链接。

  `PDF_OPEN_RESULT` 改名 `PDF_OPEN_JOB`，由它统一决定打开结果还是打开作业页（`pdf/upload.html#job=<id>`）。通知可点击，点了走同一条路。
- **文案**：面向用户的「PDF」按功能改成「文档」。28 个现有键改写英文和十种译文（键名不变），新增 23 个 `doc*` 键。只属于 PDF 的键（当前 PDF 标签页、扫描件、加密等）不动。`_locales` 不动。
- **模块**：
  - popup 的 PDF 段（`popup.js:115–484`）第一个提交原样搬进 `popup/popup-pdf.js`，之后才在新文件里改；
  - 作业卡的绘制抽成 `pdf/job-view.js`；
  - 计量是 `shared/doc-measure.js`。

  五个接近 1k 行的文件都不增长；popup.js 反而从 849 行降到约 480 行。
- 服务端一行不改。发现的服务端缺口记进 §11.3 的 backlog。

## 1. 现状（file:line，基线 78c7cd2，与 e8720a4 同树）

### 1.1 扩展

| 位置 | 现状 |
| --- | --- |
| `pdf/upload.html:30` | `accept="application/pdf,.pdf"`，只接 PDF |
| `pdf/upload.js:18–19` | 自己又写了一份 30 MiB 上限，与 `background/pdf-client.js:23` 重复 |
| `pdf/upload.js:359` | `isPdfBytes` 的第二份拷贝 |
| `pdf/upload.js:365–396` | 整本读进内存转 base64，塞进消息 |
| `pdf/upload.js:269–285` | 建作业用 bytes 源（`bytesBase64`，:276） |
| `pdf/upload.js:110–151` | awaiting_confirm 画成失败；:140 在「非活跃」时重铸操作号，待确认作业一刷新就换号 |
| `pdf/upload.js:342` | 打开结果走 `PDF_OPEN_RESULT`，只认结果 URL |
| `background/pdf-jobs.js:238–373` | `handlePdfCreateJob`：解 base64（:283）；失败记录只留 `maxPages`；:353 对 awaiting 也盖 `settledAt` |
| `background/pdf-jobs.js:40` | `base64ToArrayBuffer` |
| `background/pdf-jobs.js:56–70` | 轮询看到的状态变化只有「结束」一种，只会发结束通知（:65） |
| `background/pdf-jobs.js:158` | `startPdfUrlTranslation` 判断「已有作业在跑」只认 queued/running |
| `background/pdf-jobs.js:408–420` | `PDF_JOB_GET` 找不到记录时会新建一条 |
| `background/pdf-jobs.js:438–466` | 开结果只会开 URL（:458–460，dual/mono 互为回落），没有作业页可去 |
| `background/pdf-jobs.js:191`、`:210` | 只有通知按钮的回调（`onButtonClicked`）；整个 `background/` 没有 `notifications.onClicked` |
| `background/pdf-client.js:23`、`:30` | `MAX_PDF_BYTES`、`isPdfBytes` |
| `background/pdf-client.js:102–182` | `createPdfJob`：:114 未登录抛 `unauthorized` 401 `{loginRequired:true}`；领票不带格式（:130–133）；PUT 写死 `application/pdf`（:146） |
| `background/pdf-client.js:213` + `:254–279` | 记录的 24 h TTL 不看状态，待确认作业一天后被删 |
| `background/pdf-client.js:225` | pending 回执 10 min 判失联 |
| `background/pdf-client.js:227` | 活跃状态集合在这里又定义一遍 |
| `background/pdf-client.js:360` | URL 操作号的 TTL 绑在作业 TTL 上 |
| `background/pdf-client.js:448–505` | `refreshJobRecords` 把 awaiting 当成已结束，于是发「失败」通知 |
| `background/pdf-notify.js:24–41` | `notifyPdfTerminal`：只要不是成功，一律说「失败」 |
| `pdf/pdf-ui.js:24–43` | `pdfStatusKey` 没有 awaiting，落到缺省「排队中」 |
| `pdf/pdf-ui.js:45` | `isPdfJobActive`，活跃集合的第三份 |
| `shared/pdf-errors.js:20` | `FALLBACK_MAX_PAGES = 32`，与服务端的 1000 / 800 都对不上 |
| `shared/pdf-errors.js:23–67` | 缺 `file_too_large`、`unsupported_format`、`empty_document`、`page_count_unknown`、`not_awaiting_confirm`、`queue_timeout`、`create_timeout`、`abandoned`；`missing_source` 被说成「文件不可读」 |
| `options/options-pdf-tasks.js:107–109` | awaiting 分进「历史」 |
| `options/options-pdf-tasks.js:207`、`:224` | Open 只认结果 URL；错误文案只看 code |
| `popup/popup.js:115–484` | PDF 段，370 行，挂在一个 849 行的文件里 |
| `popup/popup.js:218–222` | `isPdfJobStillWorthShowing` 只把「活跃」当作未结束：待确认的行一小时后就从 popup 消失 |
| `popup/popup.js:255`、`:278`、`:284`、`:364` | 名字回落写死 'PDF'；Open；abandoned 标红；行内错误 |
| `i18n/lang/en.js:80` | `pdfUploadLimit` 还写着「200 pages」 |
| `i18n/lang/en.js:100`、`:102` | `pdfErrInvalid` 说「readable PDF」；`pdfErrTooLarge` 写死 30 MB |

### 1.2 服务端（translator-saas origin/main=baab9eda，只读）

| 位置 | 事实 |
| --- | --- |
| `server/lib/pdf/format.ts:52` | `DOCUMENT_FORMATS` = pdf, docx, epub, txt, md, mobi |
| `format.ts:105` | `writesBackDocument` = `format !== "mobi"` |
| `format.ts:133–138` | MIME 表（§2.1） |
| `format.ts:192` | `megabyteLabel`：`Math.round(bytes/1048576*10)/10`，整数不带小数 |
| `format.ts:238` | `formatFromFileName`：小写、取最后一个扩展名；markdown→md、azw3→mobi；不认识回 null |
| `format.ts:257`、`:305` | `SNIFF_BYTES = 68`；`matchesDeclaredFormat`：pdf 要 `25 50 44 46 2d`、docx/epub 要 ZIP 头 `50 4b 03 04`、mobi 要第 60 字节起的 `BOOKMOBI`、txt/md 必须三种都不是 |
| `server/lib/pdf/env.ts` | PDF 上传 300 MiB，但服务端只给 ≤30 MiB 的 PDF 自己数页（`pdfInspectMaxBytes`）；电子书 50 MiB；纯文本 10 MiB；流式 800 标准页；PDF 1000 页；确认窗 72 h |
| `server/app/api/pdf/uploads/route.ts` | 领票：收 `{operationId, byteSize, sourceFormat}`（`format` 是废弃别名，`fileName` 仅供参考），回 `{sourceKey, uploadUrl, maxBytes, sourceFormat, format}`；413 `pdf_too_large` / `file_too_large` 带 `{maxBytes, bytes, format}`；`unsupported_format` 不带细节 |
| `server/app/api/pdf/jobs/route.ts` | sourceKey 必须等于按（用户，操作号，格式）算出的 key，否则 403 `invalid_source_key`；:458 `missing_source` 400；:923 `create_timeout`（预留已释放） |
| 同上 · declaredUnits | fixed 要 ≥1，否则 `page_count_unknown`；超 1000 → `too_many_pages {maxPages, pageCount}`；flow 夹到 1..800。实测后：超上限 → `too_many_pages`（**不带** maxPages）；在 20% 内直接开跑；否则 awaiting_confirm |
| `server/app/api/pdf/jobs/[id]/confirm/route.ts` | POST 无 body；404、401、402 `insufficient_points`、409 `not_awaiting_confirm` |
| `server/lib/pdf/service.ts` ~:3636–3880 | 作业视图：`results` 只列存在的 key，MOBI 为 `{}`；列表不带 results，除非 `?fields=full`；`confirm {reservedUnits, measuredUnits, extraUnits, charCount, expiresAt}` 只在 awaiting **且**已计量时给；失败/放弃时 `error = {code: errorCode ?? status, message, refunded?}`（:3861–3871） |
| 同上 · 放弃 | 用户放弃不写 error_code，所以视图的 code 是 `abandoned`；queued、awaiting 退款，running 照扣 |
| `server/lib/pdf/reconcile.ts:236–257` | `queue_timeout`：只处理 running 且 stage=queued_capacity 的作业，状态记 abandoned 并退款 |
| `reconcile.ts:288–306` | 确认 72 h 无人理 → abandoned + 退款，原因 `confirm_timeout`：**只是退款原因，不是错误码** |
| `packages/cli/src/measure/characters.ts`、`zip.ts` | 计量：折叠空白后 `max(1, ceil(chars/3000))`；ZIP 读取器只认 method 0/8，遇 ZIP64、加密就抛；docx 读 `word/document.xml`；epub 读 `.x?html?`，去掉 toc/nav；txt/md 去掉开头的 U+FEFF |
| `server/lib/docs/measure.ts` | 服务端计量，本地移植的对拍基准（§9.4） |
| `/app/settings/pdf?job=<id>` | 会重定向到网页阅读台；MOBI 的唯一读法 |

## 2. 格式表与上限（`shared/doc-jobs.js`）

### 2.1 表

| 格式 | 家族 | 本地计量 | 上限 | 扩展名 | MIME（逐字取自 format.ts:133–138） | 回写文件 |
| --- | --- | --- | --- | --- | --- | --- |
| pdf | fixed | 否 | 30 MiB | .pdf | `application/pdf` | 是（双语 / 译文 PDF，直接打开） |
| docx | flow | 是 | 50 MiB | .docx | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | 是 |
| epub | flow | 是 | 50 MiB | .epub | `application/epub+zip` | 是 |
| mobi | flow | 否 | 50 MiB | .mobi .azw3 | `application/x-mobipocket-ebook` | 否（只在网页阅读台读） |
| txt | flow | 是 | 10 MiB | .txt | `text/plain` | 是 |
| md | flow | 是 | 10 MiB | .md .markdown | `text/markdown` | 是 |

PDF 取 30 MiB 而不是 300 MiB：服务端只替 ≤30 MiB 的 PDF 数页，更大的要客户端报页数，而本地数 PDF 页不在本项（§11.1）。所以 PDF 上限与今天相同。

### 2.2 API（全部是纯函数或常量，SW 与页面共用）

- 格式：
  - `DOCUMENT_FORMATS`（冻结数组）、`isDocumentFormat(x)`。
  - 逐字移植 format.ts 的四样：`formatFromFileName(name)`、`SNIFF_BYTES`（68）、`matchesDeclaredFormat(head, format)`（`head` 是 Uint8Array）、`megabyteLabel(bytes)`。
  - `contentTypeFor(format)`、`extensionFor(format)`（规范扩展名：mobi→`mobi`、md→`md`）、`maxBytesFor(format)`、`familyOf(format)`（`'fixed' | 'flow'`）、`isMeasurable(format)`、`writesBackDocument(format)`。
  - `acceptList()` → `'.pdf,.docx,.epub,.mobi,.azw3,.txt,.md,.markdown'`，供 `<input accept>` 用。
  - `FLOW_MAX_STANDARD_PAGES = 800`。
- 状态谓词（入参是状态字符串，**DocJobs 是唯一出处**）：
  - `isActiveStatus`：queued、running；
  - `isAwaitingStatus`：awaiting_confirm；
  - `isTerminalStatus`：succeeded、failed、abandoned；
  - `isUnsettledStatus`：活跃 ∪ 待确认。

  删掉 `pdf-ui.js:45` 的 `isPdfJobActive` 和 `pdf-client.js:227` 的 `isActiveStatus`，不留别名，调用方改写成 `DocJobs.isActiveStatus(view.status)`。
- 作业：
  - `jobFormat(record)` = `record.sourceFormat || formatFromFileName(record.fileName) || 'pdf'`。
  - `resultFileName(fileName, format, suffix)` → `"<base> (<suffix>).<ext>"`：
    - 从末尾去掉**一个**表里的扩展名，不分大小写；
    - `/ \ : * ? " < > |` 和 U+0000–U+001F 换成 `_`；
    - 去掉首尾空白后为空就用 `document`。
  - `jobPagePath(jobId)` = `'pdf/upload.html#job=' + encodeURIComponent(jobId)`。
  - `openTargetFor({status, format, results}, which)`：
    - 成功的 PDF，且有 URL → `{kind:'result', url}`。dual 取 `dualUrl || monoUrl`，mono 取 `monoUrl || dualUrl`，与今天 `pdf-jobs.js:458–460` 一致。
    - 其余一律 → `{kind:'page'}`。

### 2.3 装载与守护范围

- 双模 IIFE，形同 `shared/pdf-errors.js`：挂 `module.exports`，同时挂 `globalThis.DocJobs`。
- SW：`background/pdf-client.js` 在引 `pdf-errors.js` 之前 `import '../shared/doc-jobs.js'`，然后读 `globalThis.DocJobs`。
- 页面：`pdf/upload.html`、`popup/popup.html`、`options/options.html` 三张清单都把 `../shared/doc-jobs.js` 放在 `pdf-errors.js` 之前。
- 读取时机：
  - `pdf-ui.js` 装载时缺 `DocJobs` 就抛，照 `PdfUrl` 的写法；
  - `pdf-errors.js` 在**调用时**读 `globalThis.DocJobs`，因为单测会单独 require 它。
- 不进 manifest：content script 用不到它。
- **守护只罩文档面**。base64 和字节上限在漫画（`comic-client.js:33`、`:457`）、OCR（`ocr-recognize.js:27`、`:52`）、翻译缓存（`translation-cache.js:61`）里都是合法的，所以守护单测只扫这些文件：
  - `background/pdf-client.js`、`background/pdf-jobs.js`、`background/pdf-notify.js`；
  - `pdf/*.js`、`popup/popup-pdf.js`、`options/options-pdf-tasks.js`。

## 3. 传输

### 3.1 顺序（上传页）

1. 用户选文件（点选或拖放），页面先做本地拒收（§4.1），再做计量（§4.2）。
2. 页面发 `PDF_UPLOAD_TICKET`。SW 领票；领到之后才写 pending 回执。
3. 页面用 XHR 把 `File` 本身 PUT 到 `uploadUrl`，进度画进 `#pdfProgressBar`。
4. 页面发 `PDF_CREATE_JOB`，`source` 为 `{kind:'uploaded', sourceKey, sourceFormat}`。SW 建作业，把回执换成真作业记录。
5. 页面轮询 `PDF_JOB_GET`，按状态画作业卡（§5、§6）。

为什么由页面 PUT：
- 文件不必进消息：50 MiB 的 base64 是 67 MiB，已超过扩展消息的 64 MiB 上限；File、Blob 也传不进 SW。
- 进度只有 XHR 的 `upload.onprogress` 给得出来，而 SW 里没有 XHR。
- 扩展页有 `<all_urls>` 主机权限，跨域 PUT 不受 R2 CORS 的限制（R2 只放行 3310）。

### 3.2 消息契约

**`PDF_UPLOAD_TICKET`** `{operationId, byteSize, sourceFormat, fileName}` → SW `handlePdfUploadTicket`

1. `assertFeatureEnabled('enablePdfTranslation')`。
2. 防御性校验：
   - 格式不在表里 → `unsupported_format {format}`；
   - `byteSize` 不是有限正整数，或缺 `operationId` → `invalid_pdf`。
3. `pdfClient.requestUploadTicket({operationId, byteSize, sourceFormat})`：
   1. 没有 token → `unauthorized` 401 `{loginRequired:true}`，与今天 :114 相同；
   2. 超本地上限 → 413 `pdf_too_large`（pdf）或 `file_too_large`（其余），带 `{maxBytes, bytes, format}`，形状照服务端；
   3. POST `/api/pdf/uploads {operationId, byteSize, sourceFormat}`，**不发 `fileName`**（服务端只当参考）；不发废弃的 `format`；
   4. 回复里 `sourceKey`、`uploadUrl` 必须是非空字符串，且 `sourceFormat` 等于请求值，否则 `upload_failed`。
4. **领票成功之后**才写回执（§3.3）。
5. 回页面 `{sourceKey, uploadUrl, maxBytes, sourceFormat, pendingJobId}`。领票失败什么都不写。

**页面的 PUT**：`putFile(url, file, contentType, onProgress)`

- `contentType` 取 `DocJobs.contentTypeFor(format)`。
- 进度：`upload.onprogress` → `docUploadProgress {percent}`。
- 非 2xx、error、abort、timeout 一律 → `{code:'upload_failed', status}`。
- 日志只写状态码和操作号，**永不写 URL**。
- PUT 失败时页面发现有消息 `PDF_JOB_DISMISS {jobId: pendingJobId}`，把回执撤掉。
- PUT 期间挂 `beforeunload`，结束后摘掉。
- 若真环境里 XHR 被拦，改用 fetch PUT，进度条改成不定进度，并登记为偏差。

**`PDF_CREATE_JOB`** `{operationId, fileName, targetLang?, confirmCharge?, declaredUnits?, source}`

- `source` 为 `{kind:'uploaded', sourceKey, sourceFormat}` 或 `{kind:'url', url}`。bytes 源删除；其他 kind → `invalid_pdf`。
- uploaded 的顺序：
  1. upsert 回执：status 重置为 queued、`pending:true`，清掉 error 和 settledAt，**createdAt 取现在**。这样上传再久，20 min 的失联计时也从建作业才开始；上一次建作业失败留下的 failed 记录也被复位。
  2. `pdfClient.createJobFromUpload({operationId, sourceKey, sourceFormat, fileName, targetLang, confirmCharge, declaredUnits})`。输出参数不变：dual、side-by-side、无水印。
  3. 成功 → `replaceJobRecord(pendingId, …)`。settledAt **只给终态**（修 §5.1 缺陷 7）。
  4. 失败 → 保留今天的 failed 记录，但记录由 `errorRecordFrom(error)` 生成：`{code, message}` 加上 `maxPages`、`maxBytes`、`format`、`pageCount`、`refunded` 中存在的项。今天只留 `maxPages`。
  5. 计费确认 → 撤回执、带上 `details.operationId`、原样抛出。pdf-charge.test.mjs:270–285 的锚点不动。
  6. 409 家族（`operation_already_finished`、`job_conflict`、`output_conflict`）在 URL 路径上照旧释放 URL 操作号。
- 错误跨消息的形状：`replyComic`（`background.js:243`）把 `ComicApiError.toMessage()` 摊平成 `{ok:false, error:{code, message, status, ...details}}`，所以页面看到的是摊平的字段，SW 里是 `details`。读字段一律写 `error.X ?? error.details?.X`。

`PDF_JOB_CONFIRM` 见 §5.5，`PDF_OPEN_JOB` 见 §6.1，`PDF_JOB_GET` 见 §6.2。`background.js` 的分派（:176–222）加 `PDF_UPLOAD_TICKET`、`PDF_JOB_CONFIRM` 两个 case，并把 `PDF_OPEN_RESULT` 改名为 `PDF_OPEN_JOB`。

### 3.3 回执与操作号

回执：`{jobId:'local:<op>', operationId, fileName, sourceFormat, status:'queued', progress:0, results:null, error:null, pending:true, createdAt}`。

- `fileName` 缺省为 `document.<ext>`。
- **不加新的 stage**：`pdfStatusKey` 已经把 pending 记录读作 `pdfStatusUploading`。

**记录规则**

| 发生了什么 | 任务记录 |
| --- | --- |
| 本地拒收 | 不写 |
| 领票失败 | 不写 |
| 领票成功 | 写 pending 回执 |
| PUT 失败 | 页面发 `PDF_JOB_DISMISS` 撤回执 |
| 建作业要计费确认 | SW 撤回执，页面弹确认 |
| 建作业失败 | 回执改成 failed 记录（今天的行为，保留） |
| 建作业成功 | 回执换成真作业记录 |

**操作号**：页面持有 `currentFile = {file, format, operationId, uploaded?}`。`submit(confirmCharge)` 在 `ChargeConfirm.submitWithConfirmation(` 里依次做 `ensureUploaded()` 和建作业。`ensureUploaded()` 是幂等的：`currentFile.uploaded?.operationId === currentFile.operationId` 时跳过领票和 PUT。

| 情形 | 操作号 | 上传 |
| --- | --- | --- |
| 作业建成之前重试（领票、PUT 或建作业的可重试失败） | 同号 | 未传完则重新领票再传；已传完则跳过 |
| `missing_source` | 同号 | 清掉 `currentFile.uploaded`，重传 |
| 作业已是 failed / abandoned，再点重试 | 重铸 | 重传（key 跟操作号走） |
| 409 家族 | 重铸 | 重传 |
| awaiting_confirm | **永不重铸**（修缺陷 2） | — |

建作业成功后执行 `history.replaceState(null, '', '#job=' + encodeURIComponent(id))`，刷新页面能接回作业（§6.2）。

### 3.4 URL 路径（仍只接 PDF，回执仍在最前）

1. 写回执，形状与今天相同；
2. `fetchPdfFromUrl`，上限取 `DocJobs.maxBytesFor('pdf')`；
3. `DocJobs.matchesDeclaredFormat(head, 'pdf')`，替掉 `isPdfBytes`；
4. `requestUploadTicket`；
5. `putSource`：SW 用 fetch PUT，content-type 取 `contentTypeFor('pdf')`；
6. `createJobFromUpload`。

通知保持现状，只多一种：建作业直接回 awaiting 时发确认通知（§5.3）。

### 3.5 `background/pdf-client.js` 的新形状

- 新增：`requestUploadTicket`、`putSource`、`createJobFromUpload`、`confirmPdfJob(jobId)`，以及 §5.2 的 `applyJobView`、`recordFieldsFromView`、`errorRecordFrom`。
- 删除：`createPdfJob`、`isPdfBytes`、`MAX_PDF_BYTES` 及其导出、`isActiveStatus`。
- 常量：
  - `PENDING_STALE_MS` 20 min；
  - `SETTLED_TTL_MS` 24 h；
  - `UNSETTLED_TTL_MS` 96 h，即 72 h 确认窗加 24 h；
  - `URL_OP_TTL_MS` 24 h，单列，不再借作业 TTL。
- 消息名 `PDF_*` 保留（只有 `PDF_OPEN_RESULT` 改名），存储键不变。

### 3.6 base64 退场

文档路径上不再有 base64、`atob`、`btoa`、`bytesBase64`，`base64ToArrayBuffer`（`pdf-jobs.js:40`）删除。守护单测按 §2.3 的范围扫。

## 4. 本地拒收与计量

### 4.1 本地拒收（零网络请求，按顺序）

| 步 | 条件 | 错误 |
| --- | --- | --- |
| 1 | `formatFromFileName` 不认识 | `unsupported_format`（不带 format） |
| 2 | 0 字节 | `empty_document {format}` |
| 3 | 超 `maxBytesFor(format)` | `pdf_too_large`（pdf）或 `file_too_large`（其余），带 `{maxBytes, bytes, format}` |
| 4 | 前 `SNIFF_BYTES` 字节 `matchesDeclaredFormat` 不过 | `unsupported_format {format}` |
| 5 | 流式计量 `units > 800` | `too_many_pages {maxPages:800, pageCount:units, format}` |

- 删掉 `upload.js:18–19` 的上限和 `:359` 的 `isPdfBytes` 拷贝。
- 说明行 `pdfUploadLimit` 改用 `{pdf}`、`{book}`、`{text}` 三个占位，值取 `megabyteLabel(maxBytesFor(…))`。
- 五种都是确定性失败，不给「重试」（§5.7）。

### 4.2 计量（`shared/doc-measure.js` → `globalThis.DocMeasure`，只装进 upload.html）

- 逐行移植 CLI 的 `zip.ts` 与 `characters.ts`，用 `git -C /Users/dylanwang/translator-g/translator-saas show origin/main:packages/cli/src/measure/<file>.ts` 读原文，不改 saas。method 8 用 `DecompressionStream('deflate-raw')` 解（Chrome 103+ 与 Node 都有）。
- `async measureFlowUnits(bytes, format)` → `{characters, units}` 或 null。
  - null 的情形：ZIP64、加密、未知 method、找不到正文等。null **不是**拒收，只是不报 `declaredUnits`，交给服务端计量；服务端也许读得了。
- 只对 `isMeasurable(format)` 的格式调用。PDF 和 MOBI 不计量，也不报 `declaredUnits`。
- 夹具 `test/e2e/doc-fixtures.js`：CJS，用 stored 条目加 `zlib.deflateRawSync` 现场造 docx/epub/txt/md。e2e 和单测（经 `createRequire`）共用。
- 对拍：主控用同一批夹具在 scratchpad 里跑 saas 的 `server/lib/docs/measure.ts`，units 必须逐个相等（§9.4）。

## 5. 超页确认（awaiting_confirm）

### 5.1 七处缺陷

1. running → awaiting 被当成「已结束」，发出一条假的「失败」通知（`pdf-client.js:448–505` + `pdf-notify.js:24–41`）。
2. `upload.js:140` 在待确认时重铸操作号。
3. `pdfStatusKey` 对 awaiting 落到缺省「排队中」（`pdf-ui.js:24–43`）。
4. `PDF_JOB_GET` 会凭空新建记录（`pdf-jobs.js:408–420`）。
5. 设置页把待确认作业分进「历史」（`options-pdf-tasks.js:107–109`）。
6. 24 h TTL 不看状态，确认窗有 72 h（`pdf-client.js:213`）。
7. 建作业路径对 awaiting 也盖 `settledAt`（`pdf-jobs.js:353`）。

### 5.2 记录与轮询

- 轮询闹钟只在有**活跃**记录时保留。待确认作业在用户确认之前不会自己变化，72 h 后服务端会自己放弃，不必为它一直唤醒 SW。
- `refreshJobRecords` 轮询所有「非终态且非 pending」的记录，包括待确认的。它有两个入口：闹钟，以及 popup 的 `PDF_JOBS_LIST {refresh:true}`。
- `recordFieldsFromView(view)` → `{status, progress, stage || null, pageCount, results || null, error || null, confirm || null}`。
- 纯函数 `applyJobView(record, view)` → `{record, transition, leftAwaiting}`，其中 `transition` 取 `'settled' | 'awaiting' | null`。
  - **不变式：有 `settledAt` 当且仅当状态是终态**，建作业路径同样遵守。
  - 刚进入终态 → `'settled'`；从非待确认进入待确认 → `'awaiting'`；离开待确认 → `leftAwaiting: true`。
- 两个更新入口：
  - `refreshJobRecords` 返回 `{records, changes}`，`changes` 是 `applyJobView` 的结果列表；
  - `updateRecordFromView` 是页面驱动的入口，只更新已存在的记录，failed/abandoned 时释放 URL 操作号，404 分支保留。
- TTL 与容量：
  - 非终态、非 pending：保留到 `createdAt + 96 h`；
  - 终态：`(settledAt || createdAt) + 24 h` 后清掉；
  - pending：20 min 后判 failed `no_response`，与今天相同；
  - `capRecords`（20 条）先淘汰终态记录。

### 5.3 通知

只有轮询观察到的变化才发通知，入口唯一，在 `refreshPdfJobs`：

- `'settled'` → `notifyPdfTerminal`，标题按状态分：
  - succeeded → `pdfNotifyDoneTitle`；
  - abandoned → `docNotifyCancelledTitle`（新）；
  - failed → `pdfNotifyFailTitle`。
- `'awaiting'` → 新的 `notifyPdfConfirm`：
  - id `pdf-confirm-<jobId>`，`requireInteraction: true`；
  - 标题 `docNotifyConfirmTitle`；
  - 正文是 `fileName`、换行、`docNotifyConfirmBody {extra}`；没有 confirm 块时，换行后接 `docStatusAwaitingConfirm` 的文案。
- `leftAwaiting` → `clearPdfConfirmNotification(jobId)`。

页面驱动的处理器不发任何通知，因为用户正看着页面。它们是 `handlePdfCreateJob`、`handlePdfJobGet`、`handlePdfJobConfirm`、`openPdfJob`。

URL 路径自己的通知保留，并补上待确认：
- `runPdfUrlJob` 建作业直接回 awaiting 时，发确认通知；
- `startPdfUrlTranslation` 用 `isUnsettledStatus` 判断「已有作业」：待确认 → 重发确认通知；活跃 → `notifyPdfRunning`。

**守护**：`notifyPdfTerminal(` 只出现在 `refreshPdfJobs` 里；上面四个处理器的函数体里没有 `notifyPdf`。

接受的缺口：
- 待确认过期后被取消，要等下一次轮询才发现；
- 页面先看到的待确认不发通知，popup 会显示「查看」行；
- pending 扫描判失败时通不通知，维持现状；
- 超过 20 min 的超慢上传会先被 pending 扫描判失联，建作业时的 upsert 再把它复位。

### 5.4 状态文案（`pdf/pdf-ui.js`）

- `pdfStatusKey`：awaiting → `docStatusAwaitingConfirm`（修缺陷 3）。
- 新增 `pdfStatusLine(view, t)` → `{text, isError}`：
  - failed → 错误文案（`pdfErrorMessage`），`isError: true`；
  - abandoned → `isError: false`，放弃不算错。文案按 code 和 refunded 挑：
    - code 是 `queue_timeout` → `docErrQueueTimeout`；
    - 否则 `refunded` 为真 → `docErrAbandonedRefunded`；
    - 否则 → `pdfStatusAbandoned`。
  - 其余 → `pdfStatusKey` 的文案，`isError: false`。
- popup、设置页、作业卡都用它，不再各自判断红不红。

### 5.5 确认面板与「继续」

- 作业页 `#docConfirmPanel`：
  - 有 confirm 块时，显示 `docConfirmBody {measured, reserved, extra, expires}`。`expires` 用 `Intl.DateTimeFormat(uiLang, {dateStyle:'medium', timeStyle:'short'})` 格式化。
  - 没有 confirm 块时，只显示 `docStatusAwaitingConfirm`；按钮照常可按。
  - 按钮：`#docConfirmContinue`（`docConfirmContinue`）和现有的 `#pdfAbandon`。
  - 待确认时停止轮询，「继续」成功后恢复。
- SW `PDF_JOB_CONFIRM {jobId}` → `handlePdfJobConfirm`：
  1. `pdfClient.confirmPdfJob(jobId)`；
  2. `applyJobView`；
  3. `ensurePdfPollAlarm()`；
  4. 清掉确认通知；
  5. 回作业视图。
- 错误：
  - 409 → `docErrNotAwaiting`，然后重新拉一次作业；
  - 402 → `pdfErrInsufficientPoints`，「继续」「放弃」都留着；
  - 401 → 登录按钮；
  - 404 → 通用失败文案。

### 5.6 popup 与设置页

- popup（`popup/popup-pdf.js`）：
  - 显示非终态行，以及结束不到 1 h 的行。`isPdfJobStillWorthShowing` 改问 `isUnsettledStatus`，1 h 常量不变。
  - 待确认行给「查看」（`docReview`）：发 `PDF_OPEN_JOB` 后 `window.close()`。
  - 只有终态行能移除。
  - 名字回落 `pdfTasksUnnamed`，不再写死 'PDF'。
  - 只有 `isError` 才标红。
- 设置页（`options/options-pdf-tasks.js`）：
  - 按 `isUnsettledStatus` 分「进行中 / 历史」；只在有活跃作业时轮询；
  - 待确认行加「查看」；
  - 状态行用 `pdfStatusLine`；
  - Open 改走 `PDF_OPEN_JOB`；
  - `PDF_UI.pdfLibraryUrl(accountSiteBase, job.jobId)` 这个锚点保留（pdf-jobs.test.mjs:448–460）。

### 5.7 哪些失败不给「重试」

- `isRetryablePdfFailure(error)` 放在 `shared/pdf-errors.js`，由 `pdf-ui.js` 转出。
- 以下返回 false：`unsupported_format`、`empty_document`、`file_too_large`、`pdf_too_large`、`too_many_pages`、`page_count_unknown`、`encrypted_pdf`、`scanned_unsupported`、`invalid_pdf`、`insufficient_points`、`feature_disabled`、`abandoned`。
- `queue_timeout`、`create_timeout`、`missing_source`、网络类都给重试。
- 「重试」只在页面手里有文件时出现。从 `#job=` 接管的作业没有文件，不给。

## 6. 结果与路由

### 6.1 `PDF_OPEN_JOB {jobId, which?}`（原 `PDF_OPEN_RESULT`）

SW `openPdfJob`：

1. `local:` id → `result_unavailable` 404。
2. 现拉一次作业；本地有记录才更新它，不新建。
3. `jobFormat(record ?? {})` 与视图一起交给 `openTargetFor`；拉取失败 → `page`。
4. `chrome.tabs.create`：打开结果 URL，或 `chrome.runtime.getURL(jobPagePath(id))`。
5. 回 `{opened:'result' | 'page'}`。

调用方有四个：popup 的「打开」「查看」、设置页的「打开」「查看」、通知点击（§6.4）。作业页自己不调它（§6.3）。守护：全仓不再出现 `PDF_OPEN_RESULT`。

### 6.2 作业页 `pdf/upload.html#job=<id>`

- 加载时 hash 带着非 `local:` 的 id → 接管：画作业卡；活跃时轮询；待确认时出面板。不给「重试」。
- 用户选了新文件 → 清掉 hash，回到上传流程。
- 作业 404 → 通用失败文案。
- `PDF_JOB_GET` 回 `{...view, sourceFormat, fileName}`，这两项在本地有记录时从记录补上。**永不新建记录**（修缺陷 4）。
  - 没有记录时（被清掉，或 hash 是手贴的），格式按 `jobFormat` 回落到 pdf。服务端视图不带格式，记在 §11.3。

### 6.3 作业页取结果

- **PDF**：沿用 `#pdfOpenDual` / `#pdfOpenMono`。点了先现拉一次作业（签名 URL 有时效），再 `chrome.tabs.create` 结果 URL。
- **docx / epub / txt / md**：新按钮 `#docSaveDual`（`docSaveDual`）、`#docSaveMono`（`docSaveMono`），对应 URL 不存在就不显示。
  1. 现拉一次作业，fetch 签名 URL，得到 blob；
  2. `DocJobView.downloadBlob(blob, DocJobs.resultFileName(fileName, format, t(suffixKey)))`；suffixKey 为 `docResultBilingualSuffix` 或 `docResultTranslatedSuffix`；
  3. `downloadBlob` 建 object URL，点一个 `<a download>`，把它从 DOM 移走，约 60 s 后 revoke。

  为什么不直接开 URL：结果对象没有 content-disposition（§11.3），浏览器会按 R2 的 key 命名；txt/md 还会在标签页里直接显示，不下载。
- **MOBI**：`#docNoFile` 显示 `docNoFile`。
- **所有成功的作业**都给一个「在网站上查看」链接（`pdfTasksViewOnWeb`）：`PDF_UI.pdfLibraryUrl(base, jobId)`，base 取自 `ACCOUNT_SITE_BASE` 回复的 `response.data.base`，照 `options-pdf-tasks.js:45–49`。

### 6.4 通知点击

- `pdf-notify.js` 拥有两个 id 前缀 `pdf-job-`、`pdf-confirm-`，以及纯函数 `jobIdFromNotificationId(id)`。其他前缀（如 `pdf-charge-`）回 null。
- `pdf-jobs.js` 顶层注册唯一一个 `chrome.notifications.onClicked`：取到 jobId → `openPdfJob` → 清掉该通知；`local:` id 只清通知。
- `pdfNotifyDoneBody` 改成「Click to open it.」，这句现在是真的了。

## 7. 错误与文案

### 7.1 错误码 → 文案键（`shared/pdf-errors.js`）

- 签名改成 `pdfErrorMessageKey(code, error?)`。只给 code 时回基础键；给了 error 再细分。`pdfErrorMessage(error, translate)` 把 error 传进去。删掉 `FALLBACK_MAX_PAGES`。

| code | 键 |
| --- | --- |
| `file_too_large`、`pdf_too_large` | `pdfErrTooLarge {max}`，`max` = `megabyteLabel(maxBytes ?? maxBytesFor(format))` |
| `unsupported_format` | `format` 在表里 → `docErrMismatch`；否则 → `docErrUnsupported` |
| `empty_document` | `docErrEmpty` |
| `page_count_unknown` | `docErrPageCountUnknown` |
| `not_awaiting_confirm` | `docErrNotAwaiting` |
| `too_many_pages`，没有 maxPages | `docErrTooManyPagesNoMax` |
| `too_many_pages`，流式且有 pageCount | `docErrTooLongFlow {pageCount, maxPages}` |
| `too_many_pages`，其余 | `pdfErrTooManyPages {maxPages}` |
| `queue_timeout` | `docErrQueueTimeout` |
| `create_timeout` | `pdfErrUnavailable` |
| `missing_source` | 从 `pdfErrInvalid` 改到 `pdfErrNetwork`：上传没有到达，重试会重传 |
| `abandoned` | refunded → `docErrAbandonedRefunded`；否则 → `docErrAbandoned` |

其余映射不变。

### 7.2 改写的 28 个现有键（键名不变，十种语言都给真译文）

| 键 | 新英文 |
| --- | --- |
| `pdfPagesRemainingLabel` | Document pages left |
| `freeQuotaDesc` | Comic and document translation share one account. Free pages refill at the start of every month. |
| `enablePdfTranslation` | Enable Document Translation |
| `pdfAccountShared` | Same account as comic translation. 20 document pages free every month. |
| `pdfHowTo` | Open a PDF and use the extension popup or the right-click menu, or upload a PDF, Word, EPUB, MOBI, TXT or Markdown file from the popup. |
| `pdfTranslateLocal` | Translate a Local Document… |
| `pdfUploadTitle` | Translate a Document |
| `pdfUploadDrop` | Drop a document here, or click to choose a file |
| `pdfUploadLimit` | PDF up to {pdf}; Word, EPUB and MOBI up to {book}; TXT and Markdown up to {text}. Scanned PDFs are not supported. |
| `pdfSignInRequired` | Sign in to translate documents |
| `pdfErrInsufficientPoints` | Not enough free pages left this month for this document |
| `pdfErrTooManyPages` | This document has too many pages ({maxPages} max) |
| `pdfErrInvalid` | This file is not a readable document |
| `pdfErrTooLarge` | This file is too large ({max} max) |
| `pdfErrUnavailable` | Document translation is temporarily unavailable |
| `pdfErrRetry` | The previous attempt for this document already ended — try again to start a new one |
| `pdfErrOutputConflict` | This document already has a task with different settings — try again to start a new one |
| `pdfFailed` | Document translation failed |
| `pdfTasksTitle` | Document Translation Tasks |
| `pdfTasksEmpty` | No document translations yet. |
| `pdfTasksSignedOut` | Sign in to see your document translation tasks. |
| `pdfTasksUnnamed` | Untitled document |
| `pdfNotifyNotPdfBody` | Open a PDF and try again, or use “Translate a Local Document…”. |
| `pdfNotifyDoneTitle` | Document translation finished |
| `pdfNotifyDoneBody` | Your translation is ready. Click to open it. |
| `pdfNotifyFailTitle` | Document translation failed |
| `pdfChargeRequired` | This document costs {points} credits. You have {balance}. |
| `pdfChargeConfirm` | This document costs credits. Translate it? |

仍只属于 PDF、不改的键：`contextTranslatePdfLink`、`contextTranslatePdfPage`、`pdfTranslateThis`、`pdfNotifyNotPdfTitle`、`pdfNotifyStart*`、`pdfNotifyRunning`、`pdfNotifyChargeTitle`、`pdfAskPrompt`、`pdfErrSourceFetch`、`pdfOpenDual`、`pdfOpenMono`、`pdfErrScanned`、`pdfErrEncrypted`。

### 7.3 新增的 23 个 `doc*` 键（十个 `i18n/lang/*.js` 都放在 `pdfNotifyChargeTitle` 之后）

| 键 | 英文 |
| --- | --- |
| `docStatusAwaitingConfirm` | Needs your confirmation |
| `docConfirmBody` | This document turned out longer than estimated: {measured} pages instead of {reserved}. Continuing uses {extra} more pages. If you do nothing, it is cancelled on {expires} and fully refunded. |
| `docConfirmContinue` | Continue |
| `docNotifyConfirmTitle` | A document needs your confirmation |
| `docNotifyConfirmBody` | {extra} more pages than estimated. Click to review. |
| `docNotifyCancelledTitle` | Document translation cancelled |
| `docReview` | Review |
| `docSaveDual` | Save Bilingual File |
| `docSaveMono` | Save Translated File |
| `docNoFile` | This result is read on the website — there is no file to download. |
| `docResultBilingualSuffix` | bilingual |
| `docResultTranslatedSuffix` | translated |
| `docErrUnsupported` | This file type is not supported. Use PDF, Word (.docx), EPUB, MOBI, TXT or Markdown. |
| `docErrEmpty` | This file is empty |
| `docErrMismatch` | This file's contents do not match its extension |
| `docErrPageCountUnknown` | Could not count the pages in this document |
| `docErrNotAwaiting` | This task no longer needs confirmation |
| `docErrTooManyPagesNoMax` | This document has too many pages |
| `docErrTooLongFlow` | This document is about {pageCount} pages long; the limit is {maxPages} |
| `docErrAbandoned` | This task was cancelled |
| `docErrAbandonedRefunded` | This task was cancelled and the pages reserved for it were refunded |
| `docErrQueueTimeout` | The service was too busy to start this document in time. The pages reserved for it were refunded — try again. |
| `docUploadProgress` | Uploading… {percent}% |

- 占位符在十种语言里必须与英文一一对应。
- `i18n-locale-coverage` 的 `KNOWN_GAP` 是空的，新键缺一种语言单测就红。

### 7.4 `_locales` 不动

`_locales/*/messages.json` 只放 manifest 用的三个键（appName、appDescription、cmdTogglePage），本项不新增 manifest 级文案。appDescription 里「…PDF, comics.」要不要提文档，属于商店文案，列为用户待办。

## 8. 界面与模块

### 8.1 文件

| 文件 | 新 / 改 | 内容 |
| --- | --- | --- |
| `shared/doc-jobs.js` | 新 | `DocJobs`（§2） |
| `shared/doc-measure.js` | 新 | `DocMeasure`（§4.2） |
| `pdf/job-view.js` | 新 | `DocJobView`：只画作业卡（状态行、进度、按钮显隐、确认面板、结果区）和 `downloadBlob`；不发消息、不持状态 |
| `popup/popup-pdf.js` | 新（搬家后再改） | popup 的 PDF 段 |
| `pdf/upload.js` | 改 | 接收、拒收、计量、领票/上传、建作业、轮询、接管、保存；`PDF_UPLOAD_TICKET`、`PDF_JOB_CONFIRM` |
| `pdf/upload.html`、`pdf/upload.css` | 改 | accept 由 `DocJobs.acceptList()` 在运行时填；新增 `#docConfirmPanel`、`#docConfirmContinue`、`#docSaveDual`、`#docSaveMono`、网站链接、`#docNoFile`；样式放 upload.css |
| `pdf/pdf-ui.js` | 改 | `pdfStatusKey` 加 awaiting、`pdfStatusLine`、转出 `isRetryablePdfFailure`；删 `isPdfJobActive` |
| `shared/pdf-errors.js` | 改 | §7.1、`isRetryablePdfFailure` |
| `background/pdf-client.js` | 改 | §3.5、§5.2 |
| `background/pdf-jobs.js` | 改 | 领票、建作业、确认、`openPdfJob`、`onClicked`、URL 路径 |
| `background/pdf-notify.js` | 改 | 标题按状态、确认通知、id 前缀与 `jobIdFromNotificationId` |
| `background/background.js` | 改 | 三个 case（§3.2） |
| `popup/popup.html`、`popup/popup.js` | 改 | 装载 `doc-jobs.js`、`popup-pdf.js`；popup.js 只留一句 `setupPdfSection()` |
| `options/options.html`、`options/options-pdf-tasks.js` | 改 | 装载 `doc-jobs.js`；§5.6 |
| `i18n/lang/*.js` ×10 | 改 | §7 |
| `test/unit/helpers/sources.mjs` | 改 | 新增 `popupSource()`（`surfaceSource('popup', n => n.endsWith('.js'))`）、`uploadPageSource()`（`surfaceSource('pdf', n => n.endsWith('.js'))`） |
| `test/e2e/doc-fixtures.js`、`test/e2e/doc-service-mock.js`、`test/e2e/document-formats.spec.js` | 新 | §9.2 |
| `test/unit/doc-jobs.test.mjs`、`test/unit/doc-measure.test.mjs` | 新 | §9.1 |

装载顺序：
- `upload.html`：i18n ×10、`messages.js`、`comic-charge.js`、`doc-jobs.js`、`pdf-errors.js`、`pdf-url.js`、`pdf-ui.js`、`doc-measure.js`、`job-view.js`、`upload.js`。
- `popup.html`：`… doc-jobs.js、pdf-errors.js、pdf-url.js、pdf-ui.js、popup-pdf.js、popup.js`。
- `options.html`：`doc-jobs.js` 插在 `pdf-errors.js`（:861）之前。

### 8.2 popup 分两个提交

**提交 1 纯搬家**：
- `popup.js:115–484` 原样移进 `popup/popup-pdf.js`：从 :115 的段头注释起，到 :481–484 的 `onPdfTranslateLocal` 止。
- `popup.html` 在 `popup.js` 之前加 `<script src="popup-pdf.js">`。
- 加上 `popupSource()`。
- 测试只做最小改指向：pdf-jobs.test.mjs:171–181；pdf-charge.test.mjs:262–268、:300–307、:309–325；ui-language 的 CALLERS。
- 这个提交不改任何行为，两道门必须和基线同数。

**提交 2 起才改**：
- `popup-pdf.js` 自己取元素，提供 `setupPdfSection()`。它替掉 `popup.js:76` 的 `refreshPdfSection()` 和 `:847–848` 的两个监听。
- 加上待确认 / 「查看」、`PDF_OPEN_JOB`、`pdfStatusLine`。
- 它只向 popup.js 借 `t()`，在调用时解析。
- 守护：`popup/*.js` 之间不得有重复的顶层名字（classic script 共用一个全局词法环境，重名会在装载时抛）。

P0-C rebase 之后的顺序是 `pdf-ui.js → translation-display.js → popup-display.js → popup-pdf.js → popup.js`；预计 popup.html、popup.js 各有一处小冲突。

### 8.3 作业卡的边界

- `job-view.js` 是纯绘制：给它 `{view, format, fileName, hasFile, webBase}`，它决定哪些按钮显示、写哪句状态、确认面板写什么。
- `upload.js` 持有全部状态和消息。
- popup、设置页不用 job-view：它们画的是列表行，不是作业卡。

### 8.4 1k 行规则

| 文件 | 基线 | 预计 |
| --- | --- | --- |
| `popup/popup.js` | 849 | ~480 |
| `pdf/upload.js` | 444 | ~550 |
| `background/pdf-client.js` | 509 | ~560 |
| `background/pdf-jobs.js` | 480 | ~600 |
| `options/options-pdf-tasks.js` | 235 | ~270 |
| `options/options.html` | 882 | 883 |
| `options/options.js` | 895 | 不动 |

新文件都在 300 行以内。任何文件越过 1000 行，就拆模块，不许硬塞。

## 9. 测试

### 9.1 单测

**新文件**

- `doc-jobs.test.mjs`：
  - 格式表，以及它与 saas MIME 表的一致（MIME 表抄进测试做常量）；
  - `formatFromFileName`、各格式的嗅探、`megabyteLabel`、`acceptList`；
  - 状态谓词、`jobFormat`、`resultFileName`（非法字符、控制字符、大小写扩展名、空名）、`jobPagePath`；
  - `openTargetFor` 矩阵：格式 × 状态 × 有无 URL × dual/mono。
- `doc-measure.test.mjs`：
  - stored 与 deflate 条目；docx；epub（nav/toc 不计）；带 U+FEFF 的 txt；md；
  - ZIP64、加密、未知 method 回 null；
  - 3000 字符的边界；空白折叠。

**守护（范围按 §2.3）**

- 字节上限只在 DocJobs：文档面上不得出现 `MAX_PDF_BYTES` 或 `x * 1024 * 1024` 形的上限字面量；
- `isPdfBytes` 全仓消失；
- 状态集合只在 DocJobs：`isPdfJobActive` 全仓消失，文档面不得自拼 queued/running 集合；
- 四张装载清单（SW import、upload.html、popup.html、options.html）里 `doc-jobs` 都在 `pdf-errors` 之前；
- 文档面没有 base64；
- 全仓没有 `PDF_OPEN_RESULT`；
- `popup/*.js` 顶层名字不重复；
- 通知守护（§5.3）；
- `notifications.onClicked` 注册在模块顶层。

**行为**

- `applyJobView` 矩阵：每种状态对每种状态，查 transition、leftAwaiting、settledAt 不变式；
- TTL：待确认 95 h 仍在，97 h 被清；终态 24 h；pending 20 min；
- `capRecords` 先淘汰终态；
- 建作业路径对 awaiting 不盖 settledAt；
- `refreshJobRecords` 轮询待确认、跳过 pending；
- 失败/放弃时释放 URL 操作号；
- `jobIdFromNotificationId`；
- §7.1 的新映射；`isRetryablePdfFailure`；`pdfStatusLine`；
- pdf-jobs.test.mjs:121–125 的 `pdfStatusKey` 断言保留。

**前提变化（逐条登记进交付报告，格式「原前提 → 新前提 → 为什么」）**

- pdf-jobs.test.mjs：
  - :171–181 → `popupSource()`；
  - :193–204 → URL 源：回执仍在 `fetchPdfFromUrl` 之前；uploaded 源：回执在领票处理器里、领票成功之后写，建作业的 upsert 在 `createJobFromUpload` 之前；
  - :370–381 → `uploadPageSource()`；
  - :390–400 → 装载顺序加 doc-jobs；
  - :431 → `docErrTooManyPagesNoMax`；
  - :436–446 → 占位符集合加 `{max}`、`{pageCount}`、`{maxPages}`、`{measured}`、`{reserved}`、`{extra}`、`{expires}`、`{percent}`、`{pdf}`、`{book}`、`{text}`。
- pdf-charge.test.mjs：
  - :125 → `createJobFromUpload`；
  - :262–268、:309–325 → 表面 helper；
  - :270–285 锚点保留；
  - :300–307 → `popup-pdf.js`。
- ui-language.test.mjs:77–83 的 CALLERS → 表面 helper。
- pdf-offer.test.mjs:146–153 → 对 doc-jobs 做同类断言。

### 9.2 e2e 旅程（验收单元）

**共用 mock**：`test/e2e/doc-service-mock.js`，从 `pdf-translation.spec.js` 抽出来再扩展。
- 必须建在 `test/e2e/mock-server.js` 的 `startMockServer` 上：自起服务器的 spec 会被守护单测拦下。
- 它记录：领票请求体（可配 413）、PUT 的 content-type 与长度、建作业请求体。
- 它提供：按脚本推进的 GET 序列、`POST /confirm`、列表、结果文件。
- `pdf-translation.spec.js` 的现有旅程改走新传输，断言不减。

**旅程（新 spec `test/e2e/document-formats.spec.js`）**

| # | 旅程 | 断言 |
| --- | --- | --- |
| J-E1 | 上传 docx 到保存 | 领票体 `{operationId, byteSize, sourceFormat:'docx'}`，无 `fileName`、无 `format`；PUT 的 content-type 是 docx MIME，长度等于文件；建作业体的 `sourceFormat`、`declaredUnits`（等于夹具的期望值）、`sourceKey`、输出参数；点「保存双语文件」触发下载，文件名 `report (bilingual).docx`，内容等于 mock 给的字节；作业卡与按钮的几何（可见、在视口内） |
| J-E2 | 上传 epub 到保存 | 同 J-E1；夹具的 nav 大到计入就会跨过 3000 字符边界，以此证明 nav 不计 |
| J-E3 | 待确认 | 见下 |
| J-E4 | MOBI | 建作业体没有 `declaredUnits`；PUT 的 MIME 是 `application/x-mobipocket-ebook`；成功后出 `docNoFile` 和网站链接，href 等于 `pdfLibraryUrl(base, id)`；几何 |
| J-E5 | 五种本地拒收 | 未知类型、空文件、超上限（10 MiB + 1 的 txt）、嗅探不符（内容不是 ZIP 的 .docx）、过长（超过 2 400 000 字符的 txt）；领票请求数为 0；每种文案逐字等于对应键的译文；「重试」隐藏 |
| J-E6 | 路由 | popup 里点成功流式作业的「打开」，开出作业页（URL 以 `pdf/upload.html#job=<id>` 结尾）；点成功 PDF 作业的「打开」，开出结果 URL |
| J-E7 | 只有译文的 docx（验收时补，§13.3 H） | mock 只给 `monoUrl`（网站上建的 mono 作业）；「保存译文」可见、「保存双语文件」隐藏；下载文件名 `<名> (translated).docx`，内容等于 mock 给的 mono 字节；几何 |

J-E3 的步骤：
1. mock 的第一次 GET 回 queued；建作业后关掉上传页。
2. mock 把作业改成 awaiting_confirm，带 confirm 块。
3. 打开 popup，`refresh:true` 触发轮询。
4. 事先包过的 SW `chrome.notifications.create` 记到 `pdf-confirm-<id>`，而「继续」之前的记录里**没有** `pdf-job-<id>`（缺陷 1 的回归）。
5. popup 行显示待确认文案和「查看」按钮（几何）。点「查看」，开出作业页 `#job=<id>`，确认面板写着实测、预留、追加和到期时间（几何）。
6. 点「继续」：mock 收到 `POST /confirm`，作业走到 running，再到 succeeded。
7. SW 调了 `chrome.notifications.clear('pdf-confirm-<id>')`。

另在 comic-account.spec.js:400–420 补一条：功能关着时 `PDF_UPLOAD_TICKET` 回 `feature_disabled`。

几何断言沿用本回合惯例：`boundingBox()` 非空、宽高 > 0、完全落在视口内；面板与按钮互不遮挡。

### 9.3 主控真环境验收

1. 起 saas 三件套（`/Users/dylanwang/translator-g/.claude/launch.json`：saas-dev 3310、pdf-worker 8080、image-relay 8081），各自探 `/healthz`。
2. Playwright 装载 worktree 的扩展，`comicApiBase` 设为 `http://localhost:3310`；dev 登录拿 token，token 不落日志。
3. docx 用 `textutil -convert docx` 现做；epub 用夹具构造器做（mimetype 条目 stored）。
4. 两本都走到出结果：页面的 XHR PUT 直达 R2 并成功；「保存」出来的文件用 `unzip -l` 能列出。
5. 证据存 `/Users/dylanwang/translator-g/docs/delivery/evidence/p0-e/`。签名 URL、token、cookie 一律不落盘。

### 9.4 计量对拍

主控在 scratchpad 里用 §4.2 的同一批夹具，外加一份真 docx 和一份真 epub，分别跑扩展移植版和 saas `server/lib/docs/measure.ts`。`characters` 与 `units` 必须逐个相等。不等就是移植错了，打回。

## 10. 文档

- `docs/privacy-policy.md`，逐行对照代码写：
  - :46、:75、:76 改成：六种格式由扩展页经一次性预签名地址上传；
  - :18、:28、:31、:65、:67、:86、:90 措辞从 PDF 改为文档；
  - :128 通知用途改为「完成、需要确认、已取消」；
  - :129 闹钟改为「只在有作业运行时」。
- CHANGELOG：`## Unreleased` 下新增一个 `###` 小节。
- README：新增「Document Translation / 文档翻译」一节（英文、中文各一），入口、格式、上限、确认、保存逐条对照真实 DOM 和写入函数。
- `translator/CLAUDE.md`：
  - helper 列表加 `popupSource()`、`uploadPageSource()`；
  - Account-Backed Features 的「PDF translation」改为「document translation」；
  - 加一小节「Document Translation」：DocJobs 是格式与状态的唯一出处、页面 PUT、待确认、`PDF_OPEN_JOB` 路由。
- 商店文档、`_locales` 不动。

## 11. 不做、交界与服务端 backlog

### 11.1 不做

- 非 PDF 的 URL 或右键入口；
- 本地数 PDF 页（因此 PDF 上限仍是 30 MiB）；
- 术语表选择；dual/mono 输出选择；
- downloads 权限；
- 本地计量 MOBI；
- 断点续传；
- 显示排队阶段；
- popup 里显示上传百分比；
- 改 popup 的 3 s 轮询；
- `_locales`、商店文档。

### 11.2 与 P0-C、P1 的交界

- **P0-C**：本项不碰 P0-C 的文件，它们在本 worktree 的基线里也不存在：
  - `shared/translation-display.js`、`popup/popup-display.js`、`background/commands.js`、`content/page/insert.js`、`content/css/translation.css`。

  rebase 时预计在 popup.html 的装载段、popup.js 的 DOMContentLoaded 与监听段各有一处小冲突，按 §8.2 的顺序解。
- **P1**：`pdf/`、`background/pdf-*.js` 按协调表归 P0-E。本项不碰以下 P1 的地盘：
  - collect.js、manifest 的 content_scripts、site-rules；
  - api-client、ai-translate、prompts、batch；
  - 输入框写回。
- 共用文件（options.html、i18n、CHANGELOG、README）按块追加，不改别人的块。

### 11.3 服务端 backlog（记录，不修）

1. `fileNameFor` 永远给 `.pdf`。
2. 作业视图不带 `sourceFormat`：本地没有记录时，扩展只能回落到 pdf（§6.2）。
3. `pdfTasksPages` 对流式作业按标准页计。
4. 没有查询上限的接口，扩展只能镜像 env.ts。
5. 列表不带签名 URL。
6. 30–300 MiB 的 PDF 要客户端数页。
7. 结果对象没有 content-disposition。
8. CLI 的嗅探与服务端不一致。
9. 网页上传的 picker 缺 `.markdown`、`.azw3`。
10. 已上传的源文件可能成孤儿：领了票、PUT 了，却没建作业。
11. 实测后的 `too_many_pages` 不带 maxPages。
12. MOBI 只预留 1 页，几乎必然进确认。
13. 领票的格式错误（400）不带细节。
14. 计量按压缩包里的 xhtml 文件名数页，引擎按 OPF spine 读：spine 为空的 EPUB 先计页扣费，再以 `empty_document` 失败、退款（§13.3 C）。
15. 阶段字没有对外契约：扩展只能镜像引擎的 `STAGES`、`FLOW_STAGES` 和 `PDF_MERGING_STAGE`。引擎新增一个阶段字，扩展查不到表，状态行就回落到「翻译中」（§13.3 F）。

## 12. 决策登记（台账 D-299）

a. **传输**：SW 领票、页面 PUT、SW 建作业；文档路径去掉 base64；URL 路径仍由 SW 取与 PUT。
b. **上限**：镜像 env.ts，唯一出处是 `DocJobs.maxBytesFor`；PDF 30 MiB 是因为服务端只替 ≤30 MiB 的 PDF 数页。
c. **服务端错误码**：本地拒收用服务端同名同形的码（`file_too_large {maxBytes, bytes, format}` 等）；`missing_source` 改说网络并可重试。
d. **declaredUnits**：流式可测的就报，测不出就不报；PDF、MOBI 不报；超 800 本地拒。
e. **待确认**：一等状态，修七处缺陷；只有轮询观察到的变化才发通知；TTL 按状态分。
f. **路由**：`PDF_OPEN_JOB` 统一出口；PDF 直开结果，其余去作业页；通知可点。
g. **文案**：改写键的英文与译文，不改键名；新键前缀 `doc*`；`_locales` 不动。
h. **模块**：`doc-jobs`、`doc-measure`、`job-view`、`popup-pdf` 四个新文件；popup 第一个提交纯搬家。
i. **确定性失败不给重试**：清单见 §5.7。
j. **URL 路径仍只接 PDF**。

## 13. 实现偏差（实现时登记）

实现 agent 的交付报告申报了 32 条。主控逐条对照代码和本设计，分三类登记：
- 13.1 是真偏差，按「原前提 → 新前提 → 为什么」写；
- 13.2 是报告当成偏差、其实照设计原文实现的；
- 13.3 是主控验收时补记的事实和修正。

行号指本 worktree 的产品代码；13.3 H 只改测试，不影响这些行号。

### 13.1 真偏差

| 报告条 | 原前提 | 新前提 | 为什么 |
| --- | --- | --- | --- |
| 2、21 | 领票处理器和建作业各拼一份回执 | 回执只由 `pdfClient.receiptRecord` 生成（pdf-client.js:269，调用点 pdf-jobs.js:287、:331）；判断待定记录一律用 `isPendingRecord`（pdf-client.js:286），`pending: true` 只在 `receiptRecord` 里写一次 | 同一形状写两处，迟早漂移 |
| 4 | `jobFacts` 只读本机记录 | 本机没有记录时回落到视图的 `fileName`，再由 `DocJobs.jobFormat` 按扩展名推格式（pdf-jobs.js:465） | 视图不带 `sourceFormat`（§11.3 第 2 条）；手贴 `#job=`、换设备、记录过期时，只剩文件名可用 |
| 5 | 只要求领票时有 operationId（§3.2 :170） | 建作业缺 operationId 也拒，码为 `invalid_pdf`（pdf-jobs.js:320） | 没有 operationId 就不能幂等重提，也对不上领票时的 sourceKey |
| 7 | §5.5 只在 CONFIRM 第 3 步补闹钟 | `foldPageView` 每次都补（pdf-jobs.js:483） | §12 e「只有轮询发通知」的前提是：有活跃作业时，闹钟一定在 |
| 8 | `unsupported_format` 一律带 `{format}` | 只有格式是非空字符串才带（pdf-jobs.js:280–281） | 文案的占位符不能填空值 |
| 12 | 确认时的 409 按错误显示 | 先重拉一次作业，再给中性提示，不标红（upload.js:344–347） | 409 说明作业已不在待确认：别处答过了，或窗口已过。用户没做错什么 |
| 20 | 提交统一署 Opus 5.5 | 9c0e3b2–2760df6 署 Opus 5.5，a00ac7b–8ec60ff 署 Opus 5；e3816c5、c21446f 署 Opus 5.5，核实结果见 13.3 H | 署名写实际写出提交的模型 |
| 31 | 新文件不超过 300 行（:593） | popup-pdf.js 400 行（纯搬家 370 行，另加 30 行） | 纯搬家的提交里再拆，就不纯了；拆分登记 backlog。pdf-client.js 664 行，一并登记 |

### 13.2 照设计实现（报告申报为偏差）

§9.1 的「前提变化」清单让报告把这些改动也当偏差申报。它们都能在设计里找到原文：

| 报告条 | 设计出处 |
| --- | --- |
| 1 | §5.4 :342–352，落点 shared/pdf-errors.js:150 |
| 3 | :307 |
| 6 | :198 |
| 9、25 | :82 |
| 10 | :640 |
| 11 | :371、:413 |
| 13 | :378 |
| 14 | §7 :473；docx、epub、mobi 的上限同为 50 MiB，取 epub 为代表 |
| 15 | :382 |
| 16 | :306 |
| 17、24 | :250 |
| 18 | §9.1 行为测试 |
| 19 | 决策 g |
| 22 | §9.1 :644–648，锚点 :270–285 原样保留 |
| 28 | :654–655 |

设计没写、实现时定下的细节，主控认可：
- 23：e2e 夹具里又抄了一份 crc32，成了第三份；13.3 H 合成一份。
- 26：mock 的作业 id 用顺序的 `pdf_job_N`。
- 27、32：重复派发留下 4 个提交（82710bd、8360e61、c678f66、d18a054），内容被后续提交覆盖，保留；squash 合并后不留痕。
- 29：UI 语言交给 e2e harness 固定（d756441），旅程不再各设各的。
- 30：缺陷 5 用源码守卫加变异自检，因为设置页没有行为测试台。

### 13.3 主控验收补记

证据在 `/Users/dylanwang/translator-g/docs/delivery/evidence/p0-e/`，真环境部分在其下 `real-env/`。

**A. 流式格式只出一个文件，是双语的。**
- 引擎：rewrite.py 的 `rewrite()` 按输出种类只写一个文件；saas 把扩展请求的 `dual` 映射成 `both`（service.ts:1821），流式作业照样只写双语那一份。`UNWRITABLE = {"mobi"}`，MOBI 只产出阅读数据。
- 视图：`pdfJobView` 只为作业实际有的结果键签 URL（service.ts:3838–3845）。
- 所以成功后的 `results` 是：

  | 作业 | `results` |
  | --- | --- |
  | PDF | `dualUrl`、`monoUrl` 都有 |
  | docx、epub、txt、md | 只有 `dualUrl` |
  | 网站上建的 mono 作业 | 只有 `monoUrl` |
  | MOBI | `{}` |

- 真环境：run-docx.log 里视图只带 `["dualUrl"]`，「保存译文」隐藏。
- 结论：§6.3「有哪个 URL 就显示哪个按钮」成立，不改代码。扩展建的流式作业要拿纯译文，只能靠 §11.1 列为不做的输出选择，登记 backlog。

**B. 扣费确认和待确认是两回事。**
- 真环境每次建作业都先回 409 报价，点确认后带 `confirmCharge:true` 重提，得 202。这是余额确认。
- `awaiting_confirm` 是实测页数超过预留，本回合真环境没有触发，由 J-E3 的 mock 覆盖。

**C. spine 为空的 EPUB 先扣费，后失败退款。**
- 计量按文件名数出 4 页、扣 12 积分；引擎按 spine 读不到正文，以 `empty_document` 失败；saas 退款。
- 证据：worker-empty-spine.txt、server-routes.txt 的余额算术。
- 这是服务端计量与引擎不一致，登记 §11.3 第 14 条。夹具 `NOVEL_EPUB` 也是空 OPF，但 e2e 走 mock，不受影响。

**D. 计量对拍 10 例，全部相等。**
- 扩展、saas CLI、saas 服务端三方的 `characters`、`units` 逐个相等（measure-parity.txt）。
- 事先预测「两个 BOM 开头」会差 1，实测相等：JS 的 `\s` 含 U+FEFF，剩下那个 BOM 在三边都被当空白折掉。

**E. 报告 §12「e2e 没有真实下载」不属实。** document-formats.spec.js :108–114 用 `download.path()` 读盘，与 mock 给的字节逐字比对。

**F. 状态行回跳，本回合修（e3816c5）。**
- 现象：真环境 docx 的状态行走 Translating → Retypesetting → **Translating** → Done。
- 根因：旧代码用正则猜阶段字。流式引擎的 `rewrite` 含 `write`，被归到「重排」；最后的 `emit` 两条正则都不中，回落到「翻译中」。PDF 的阶段字过同一套正则，main 上就有这个缺陷。
- 修法：pdf-ui.js 改用 `PDF_STAGE_KEYS` 一张表精确查。表里收齐引擎的 `STAGES`、`FLOW_STAGES`、`names` 和 `merging`；pdf-jobs.test.mjs 加 3 条。查不到的阶段字仍回落到「翻译中」，这是 §11.3 第 15 条。
- 证据：stage-sequence-docx.txt。同一份 real.docx 修前跑一次（run-docx-before-stage-fix.log），修后跑一次（run-docx.log），与 worker 的阶段事件逐条对照。

**G. docx 译文逐段核对。** 32 段里，每个英文段后面都跟着中文译段；引擎的 `flow.untranslated` 报 5 块。

**H. mock 的结果形状照真服务端改（c21446f）。**
- 原来 mock 除 MOBI 外都发 `dualUrl` 和 `monoUrl`，J-E1、J-E2 还断言了「保存译文」的几何；真服务端的流式作业根本不给 `monoUrl`（见 A）。
- 改后 mock 按 A 的表给结果，某一步也可以显式点名要哪些文件。
- J-E1、J-E2 改为断言「保存译文」隐藏。
- 新增 J-E7：只有 `monoUrl` 的 docx 作业（§9.2）。
- 三份相同的 crc32 合成 `test/e2e/crc32.js`。守卫单测断言多项式常量 `0xedb88320` 只出现在这一个文件，并做了变异自检。
- 署名核实：e3816c5 与 c21446f 由同一个实现 agent 写成，它自报 Claude Opus 5.5（`claude-opus-5-5`），两个提交的 Co-Authored-By 都写 Opus 5.5，与自报一致。
- 门禁（c21446f）：单测 822/822；e2e 246 过、9 跳，J-E7 在 `document-formats.spec.js:267`。
