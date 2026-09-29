# P1-D 引擎层：多个 AI 配置档（按功能 / 按站点）、流式输出、超时重试与限速、失败段落就地重试

- 日期：2026-09-26；对锚修订 2026-09-28（§14）
- 基线：`origin/main@e29ab84`（manifest 1.4.0；已含 P1-B #115、R33 #118、P1-C #119）；分支 `feat/p1-d-engine-layer`（= `e29ab84` + 本文）
- 行号口径：全部是 `e29ab84` 的行号；「B§x」= P1-B 设计 `docs/plans/2026-09-24-p1-b-site-rules.md` 的小节，「C§x」= P1-C 设计 `docs/plans/2026-09-25-p1-c-glossary.md` 的小节
- 所属：P1 功能对标回合（台账 D-291）；用户裁定「不用集成机器翻译服务商接口」（D-316）；本设计的自决登记为 D-317；§14 的「自决修」交主控回填编号
- 交付：一个 PR `feat/p1-d-engine-layer`，由四批串行拼装——D1 配置档、迁移、请求客户端、超时、失败分类与缓存因子，D2 重试、限速与失败段落标记，D3 流式输出，D4 按功能 / 按站点分配的设置界面。P1-B、P1-C 已合入 main，D1 直接用 B1 的 `SyncCollection`、C1 的 `sendToModel` 与请求快照

## 0. 结论

今天扩展里只有一套 AI 配置：服务商、接口地址、Key、模型四个全局键（`background/settings.js` :31-34）。整页、划词、悬停、输入框、输入框翻译芯片、字幕、图片识别全用它，没法给字幕配一个便宜快的模型、给划词配一个好的，也没法让某个网站走公司内网的接口。发给模型的请求没有超时（`background/api-client.js` :29-50 是一次不带 `signal` 的 `fetch`），网络卡住就一直转圈；429 和 5xx 不重试；整页翻译里没译出来的段落悄悄跳过（`content/page/batch.js` :411、:628），用户看不出哪段缺了，也没法只重试那一段；划词卡片和输入框要等整句译完才出字。沉浸式翻译在这块给的是：多套 AI 服务并存、按功能指定、按站点指定，流式出字，失败段落就地重试。

用户裁定不做机器翻译服务商（DeepL、Google 等）的适配（D-316），这一轮只做 AI 这一侧：

- **入口**：设置页「AI 服务」卡片改成配置档列表（增删改、设为默认、测试连接、每档的限速与超时），下面一张「按功能分配」表（D4）；站点规则表单加「AI 配置档」下拉（D4，规则 v3）
- **存储**：`chrome.storage.sync`，一档一个键 `aiProfile:<id>`，建在 B1 的 `SyncCollection` 上，合计 ≤ 8 KiB、≤ 20 档（B§2.1 额度表预留的那一行）
- **生效点**：选哪一档在顶层帧的送出口解析（`ctx.sendTranslationCached` 取快照那一步，查缓存之前；不经缓存层的请求在 `ctx.sendTranslation` 里取），SW 按 id 取整档去发请求；超时、重试、限速、流式全在 SW 的一个请求客户端里

| # | 能力 | 边界（刻意不做的） |
|---|---|---|
| 1 | 多个配置档：名称、服务商、接口地址、Key、模型、每分钟请求数、并发数、超时 | 不做机器翻译服务商（D-316）；不做每档一份提示词，`customPrompt` 仍是全局的；≤ 20 档 |
| 2 | 按功能分配：整页、划词、悬停、输入框、字幕、图片识别，各自可指定一档，没指定的用默认档 | 每个功能至多指定一档；不做按目标语言分配 |
| 3 | 按站点：站点规则 v3 加 `profile`，这个站点的翻译请求一律用它 | 只管 TRANSLATE / 批量两种（D-302 #5）；图片识别不受站点规则管；规则钉了内置引擎时不能再选配置档 |
| 4 | 超时：每档 15–240 秒，默认 120 | 上限受 Chrome 后台单次事件 5 分钟的限制（§3.8） |
| 5 | 重试：网络错误、超时、429、5xx 自动重试，共至多 3 次尝试，间隔 1 秒、2 秒（±20%），服务端给了 `Retry-After` 就照它，至多等 60 秒 | 400 / 401 / 403 / 404 不重试；流式已经出过字的不重试 |
| 6 | 限速：每档每分钟请求数（0 = 不限，至多 600）和并发数（0 = 不限，至多 32） | 计数只在 SW 内存里，SW 被回收就清零；不跨设备 |
| 7 | 整页翻译里失败的段落就地显示「翻译失败 · 重试」，点它只重译这一段 | 只在整页翻译（手动与自动）；悬停、字幕、划词、输入框各有自己的错误显示，不动 |
| 8 | 流式出字：划词卡片的整句翻译和输入框翻译对话框 | 单词释义（结构化结果）、整页、悬停、字幕、输入框芯片（R33，直接回写到输入控件）不流式；iframe 里的划词只拿最终结果 |

### 0.1 自决（台账 D-317 已登记，此处给依据；行号已按 e29ab84 对锚）

| # | 裁定 | 依据 |
|---|---|---|
| 1 | **范围按 D-316 砍掉机器翻译服务商；剩下四项按 D1–D4 四批写** | 用户原话「不用集成机器翻译服务商接口」；多配置档、流式、超时重试限速、失败段落重试四项都在 AI 这一侧，互不依赖服务商适配 |
| 2 | **一档一个键，id 只在键里**（`aiProfile:` + 8 位 base36） | 同 B§0.1-1 与 C§0.1-1；整张表放一个键，20 档带 Key 会逼近 8 KiB 单项上限；`SyncCollection` 的 `ID_RE = /^[0-9a-z]{1,32}$/`（`shared/sync-collection.js` :38）认得下固定 id `legacy` |
| 3 | **合计 ≤ 8 KiB、≤ 20 档，单档 ≤ 2.5 KiB（按存进去的形状计）；超额拒绝，不截断** | B§2.1 给配置档预留的就是 8 KiB / 20 项；Key 至多 1024 字符、接口地址至多 512，单档最坏约 1.9 KiB；检查只有一份 `assertFits`（`shared/sync-collection.js` :156-160） |
| 4 | **写只发生在 SW 的单写者队列里**（`AI_PROFILES_WRITE`：put / remove / import / migrateLegacy） | 同 B§0.1-3；设置页、引导页、导入、迁移四个来源可能同时写；SW 分派表 `background/background.js` :178-182 已把 `SITE_RULES_WRITE` … `GLOSSARY_WRITE` 五种写消息并成一组，新消息加进这一组 |
| 5 | **Key 仍存在 `chrome.storage.sync`，放在配置档里** | 用户裁定存储不改（D-291）；今天 `apiKey` 就在 sync 里 |
| 6 | **字段名沿用 `provider`、`apiEndpoint`、`apiKey`、`modelName`** | `APICompat.requiresApiKey` / `isApiKeyMissing`（`shared/api-compat.js` :216-224）和 `describeAPIFailure`（:391）收的就是这个形状；配置档直接传进去，钥匙判断仍只有一份（D-289） |
| 7 | **按功能分配存在配置档上（`features: []`），不另开一个键** | 分配和它指向的档同生同灭，删档时不会留下指向空档的分配；「一个功能至多一档」由写队列校验 |
| 8 | **恰好一档是默认档；有别的档时默认档删不掉，最后一档可以删** | 没指定的功能总得有去处；删光等于「没配 AI」，和今天没填 Key 走同一条提示 |
| 9 | **优先级：站点规则 > 功能分配 > 默认档** | 越具体越赢；和 D-302 #3 引擎优先级「站点 > 设置」同一方向 |
| 10 | **站点规则引用的档删不掉**（`aiProfileInUse`，列出规则） | 删了规则就指向空；悄悄换成默认档是静默兜底（「删除优于兼容」） |
| 11 | **规则指向的档不存在（别的设备删了、sync 还没到）时报错，不回落** | 同上；D-302 #3「钉住的永不回退」；报错文案带配置档名的兜底「（已删除）」 |
| 12 | **选哪一档在顶层帧的送出口解析一次，在查缓存之前**：`ctx.sendTranslationCached` 取词表快照与领域开关的那一步（`content/content-translation-cache.js` :162-169）一起取，随 `opts` 交给 `ctx.sendTranslation` → `sendToModel`；结果随请求带 `profileId` 给 SW | 缓存键里的接口地址和模型出自这一档（§3.4）；子帧的请求经 `content/frames/top.js` :152-163 的 `relayEngineRequest` 直接进顶层的 `ctx.sendTranslationCached` / `ctx.sendTranslation`（不经 `ctx.requestTranslation`），所以解析必须挂在这两个送出口而不是 `requestTranslation` 上；键、附加说明、发给谁出自同一次读取（D-384 F1 的口径） |
| 13 | **每条翻译请求都要标明是哪个功能发的**（`feature`），缺了或不认识就抛 | 9 处请求字面量分在 7 个文件（§1），其中一处在 `shared/caption-core.js`；漏标会悄悄落到默认档，单测扫字面量防漏 |
| 14 | **图片识别在 SW 里自己解析 `ocr` 这一档**；识别出的文字进划词卡片，按 `selection` 译 | OCR 请求不经内容脚本的翻译出口（`content/content-image-ocr.js` :328 直发 `OCR_IMAGE`）；站点规则不管 OCR（D-302 #5） |
| 15 | **服务商不进缓存键**；C§11-1 以「不是缺陷」关闭 | 请求格式按接口地址判（`APICompat.isClaudeAPI`，`shared/api-compat.js` :106）；服务商只影响要不要 Key 和报错提示，不影响译文 |
| 16 | **缓存层读不到配置档就报错，不再「读不到就不缓存」照发** | `content/content-translation-cache.js` :39-45 今天吞掉读取失败、:174 读不到就绕过缓存直发；换成配置档后，读不到就不知道发给谁 |
| 17 | **旧的四个全局键一次性迁成固定 id `aiProfile:legacy`，然后删掉旧键**；不留双读 | 「删除优于兼容」；固定 id 让两台设备同时升级只得到一档；兼容影响见 §2.6，已在 PR 描述与收官汇报中写明 |
| 18 | **设置导出文件里旧的四个键导入时转成配置档**；新文件加 `aiProfiles` 一节，Key 只在勾选「包含 API Key」时导出 | 导出文件是已交到用户手里的格式（「删除优于兼容」的例外），旧文件不能导不进来；Key 的勾选规矩沿用 `SECRET_KEYS`（`shared/settings-transfer.js` :44） |
| 19 | **请求客户端收进 SW 一处**：`callModel(profile, request, {signal, onDelta})`，超时、重试、限速、流式、空答案判失败都在这里；设置页「测试连接」也改走它 | 今天测试连接在设置页自己 `fetch`（`options/options-connection.js` :79），超时和失败分类会写成两份 |
| 20 | **空答案算失败**（`apiErrorEmpty`） | 今天 `result \|\| text`（`background/ai-translate.js` :122、:133）把空答案换成原文当译文显示；单词模式同类：`parsed.translation = text.trim()`（:165-168）。用户以为译过了 |
| 21 | **超时上限 240 秒；请求在途时每 20 秒调一次 `chrome.runtime.getPlatformInfo()` 给 SW 续命，最后一个请求结束就停** | SW 空闲 30 秒被回收、单次事件超过 5 分钟被杀（crawl-store #1119）；扩展接口调用会重置空闲计时 |
| 22 | **重试在 SW 的请求客户端里做，每次尝试都过限速器；一批翻译只计一次额度** | 内容脚本里重试会让限速和额度各算一遍；已发字数按「发出去的请求」算是 C§3.4 的口径（`background/ai-translate.js` :174 `countCharsSentToModel`），重试不重复扣每日额度，字数照实计入 `AutoStats` |
| 23 | **流式只在顶层帧的划词卡片和输入框对话框，经 `chrome.runtime.connect` 的端口** | 两处都是用户盯着看的单条译文；单词模式回的是结构化结果，流一半没法显示；子帧划词经 frame relay，端口跨不过去（§5）；输入框芯片直接回写控件（`content/content-input-writeback.js` :174 一次 `insertText`），没有可以逐段追加的显示面，不流式（§14 自决修-C） |
| 24 | **失败标记沿用译文块的类名，再加 `ai-translator-failed`**；只在「算不算译文」的两处定义里排除它 | 收集正文、自动发现、划词都按 `ai-translator-inline-block` 跳过译文块（`content/page/visibility.js` :21-22），沿用就自动跳过；不排除的话，一页只剩失败标记时点悬浮球会变成「收起译文」 |
| 25 | **手动整页：一段失败就标；自动整页：给第二次机会，第二次还失败才标** | 自动翻译已有「重试一次再放弃」的记账（`content/content-auto-translate.js` :89 的 `retried`、:508-518 的放弃、:581 的清空），失败标记挂在放弃那一刻；手动的在 SW 重试后仍失败就是真失败 |
| 26 | **删掉没人发的 `TRANSLATE_BATCH` 消息**：SW 路由与处理函数、引擎的 case、B1 的内置类型名单；**`translateBatchWithAI` 留下**，它是快速批分隔符数量不符时的编号法回退 | `background/background.js` :135-139 路由、:374-391 `handleBatchTranslate`、引擎 :592 的 case 在产品代码里都没有发送方；`background/ai-translate.js` :277 在 `segments.length !== texts.length` 时调 `translateBatchWithAI`，删了它快速批就失去对齐回退。三条单测还在发 `TRANSLATE_BATCH`（§3.12），随消息一起改 |
| 27 | **批量分隔符收成 SW 一份**（`⟪⟫⟪⟫⟪⟫`），内容侧不再自带；C§11-2 以此关闭 | 今天五处：`content/page/batch.js` :33、`content/captions/state.js` :21（:142 导出）、`shared/caption-core.js` :436 随消息传、`background/ai-translate.js` :229 缺省、`background/background.js` :396 缺省 `'\|\|\|'`，最后一处和另外几处不一样 |
| 28 | **弹出窗口的「先去填 Key」问页面**，不再自己读全局设置 | 站点规则可能给这一页指定别的档；B§3.7 已让弹出窗口总是探测标签页（`popup/popup.js` :507-512），这里在探测结果里加 `aiReady` |
| 29 | **旅程编号用 D-J1…D-J15** | P0 已经用了 J-D1…J-D11（划词卡片几何断言叫 J-D9），同名会串 |

## 1. 现状（file:line，e29ab84）

| 位置 | 现状 | 本轮 |
|---|---|---|
| `background/settings.js` :31-34 | 四个全局键的缺省：`provider: 'openai'`、OpenAI 接口地址、空 Key、`gpt-4.1-mini` | D1：删掉；缺省移进 `AIProfiles.DRAFT`，只给「新建配置档」的表单用 |
| `background/background.js` :129-145，:356-411 | 三种翻译消息的路由（:129-133 / :135-139 / :141-145，最后一条把 `message.delimiter` 传下去）；每个处理函数自己 `chrome.storage.sync.get(defaultSettings)`（:357 / :377 / :397），再 `missingApiKeyMessage`（:359 / :379 / :399），再 `PromptAddenda.validate`（:365 / :385 / :405） | D1：处理函数收 `profileId`，从 `AIProfiles` 缓存取档；删 `TRANSLATE_BATCH`（:135-139、:374-391）；`handleBatchTranslateFast`（:396）不再收 `delimiter` |
| `background/api-client.js` :29-50 | `callTranslationAPI(endpoint, headers, body, isClaudeShape)`：一次不带 `signal` 的 `fetch`；网络错误包成 `apiFailure {network: true}`（:52 `apiError`）；`readAPIResponse` 的失败直接抛 | D1：换成 `background/model-client.js` 的 `callModel`；本文件只留请求体的拼法（:59 `callClaudeAPI`、:69 `callOpenAIAPI`）和 `countCharsSentToModel`（:101） |
| `background/ai-translate.js` :103-346 | 五个入口 `translateWithAI` :103、`translateSingleWordWithAI` :138、`translateTextWithMode` :173、`translateBatchWithAI` :186、`translateBatchFastWithAI` :229；10 处把 `settings.apiEndpoint/apiKey/modelName` 往下传（:115-117、:125-127、:147-149、:156-158、:204-206、:213-215、:245-247、:254-256）；:122/:133 `result \|\| text`；:165-168 单词空答案填回原文；:229 分隔符缺省；:277 数量不符回退编号法 | D1：参数换成 `(profile, settings)`；空答案抛 `apiErrorEmpty`；分隔符从 `shared/batch-delimiter.js` 取；`translateBatchWithAI` 留作 :277 的回退 |
| `background/ocr-recognize.js` :196-264 | `recognizeWithVision` 读 `settings.apiEndpoint/apiKey/modelName`（:208-210、:217-219），:264 调 `callTranslationAPI` | D1：SW 自己解析 `ocr` 这一档，经 `callModel` 发 |
| `background/api-errors.js` :26-30，:41-47 | `missingApiKeyMessage(settings)`；`apiErrorMessage(error, settings)` | D1：两者收配置档；加 `aiProfileMissing`、`apiErrorTimeout`、`apiErrorEmpty` |
| `options/options-connection.js` :17-23，:39-97 | `formConnection` 读表单；测试连接在设置页里自己 `fetch`（:79）；`showConnectionFailure` :102 | D1：发 `AI_PROFILE_TEST {profile}` 给 SW，走 `callModel` |
| `options/options.js` :39-44，:148-151，:226-249，:374-384，:633-635，:652，:721，:737；`options/options-models.js` :11/:59/:112/:119 | 「AI 服务」卡片读写四个全局键；模型下拉写 `modelName` | D1：卡片改成编辑一档（先只有默认档），搬进新文件 `options/options-ai-profiles.js`（§6、§10）；D4：列表、按功能分配、每档限速与超时 |
| `onboarding/onboarding.js` :185-199，:250-251 | `aiPatch` 直接写 `provider`、`apiEndpoint`、`modelName`；`chooseAiProvider` | D1：改成发 `AI_PROFILES_WRITE put`，建或更新默认档 |
| `shared/settings-transfer.js` :44，:51 | `SECRET_KEYS = ['apiKey']`；`PATTERNS.apiEndpoint` | D1：两行都删；加 `aiProfiles` 一节，旧文件的四个键经 `fromLegacy` 转 |
| `options/options-transfer.js` :48-95，:83-84，:149，:226 | `settingsSection`；换了接口地址而没带 Key 时的警告；`collectionSection(spec)`；`TRANSFER_SECTIONS` 四节 | D1：警告挪到 `aiProfiles` 一节，按档比较；`TRANSFER_SECTIONS` 加第五节 |
| `content/content-translation-engine.js` :429-458，:528-541，:831-837 | `AI_CONFIG_KEYS`（:429）；`refreshAiConfig` 读失败就把配置清空（:435-437）；`aiConfigured` :441；`fallbackAllowed` :450；`canFallBackToAI` :454；sync 增量并进 `aiConfig`（:528-541）；`engineChoices` :831（:832 调 `refreshAiConfig`，:835 `ai: aiConfigured()`） | D1：全部换成 `ctx.aiProfiles`（§3.3） |
| 同上 :678-707，:778-823 | `sendToModel(original, snap, frozen)` 是唯一的模型出口（:686 `frozen \|\| eng.addenda.settings()`）；`ctx.sendTranslation(message, opts)` :778 先等规则与词表（:781-784），:822 `sendToModel(message, snap, opts.addendaSettings)` | D1：`sendToModel` 加第四个参数 `profile`，出口前盖上 `profileId`；`sendTranslation` 的 `Promise.all` 加 `ctx.aiProfiles.whenReady()`，`opts.profile` 没交就现解析 |
| 同上 :747-762 | `ctx.withPromptAddenda` :747；`ctx.requestTranslation` :760 = 盖语域 + `sendTranslation` | 不动：解析不挂这里（§0.1-12） |
| 同上 :867-895，:900-978 | `probeStatus` 回 `engine`、`supported`、`availability`；`ctx.builtinTranslator` | D1 第 0.5 步先把 :860-978 搬去 `content/engine/probe.js`（§10）；`probeStatus` 加 `aiReady` |
| `content/content-translation-cache.js` :16，:30-48，:69-72，:115-131，:146-216 | `PROFILE_KEYS = ['apiEndpoint', 'modelName', 'customPrompt']`；`loadProfile` 读失败回 `null`（:39-45）；`GENERATION_KEYS`；`ctx.translationProfile`（:121-124 `onSettingsChanged`）；`sendTranslationCached`：内置引擎生效的请求绕过（:154-156）、快照 `sendOpts = {glossary, addendaSettings}`（:162-169）、`loadProfile()` 读不到就直发（:173-174）、`factors` 展开 `...profile`（:179-186） | D1：接口地址和模型取自快照里的配置档；`PROFILE_KEYS` 只剩 `customPrompt`；读不到配置档就抛；`sendOpts` 加 `profile` |
| `content/content-auto-translate.js` :396，:708-711，:719-720 | 费用闸 `effectiveEngine({ auto: true })`；`RESTART_KEYS` 含 `provider`、`apiKey`、`apiEndpoint`、`modelName`（:711）；:719-720 变了就 `start('settings')` | D1：`effectiveEngine` 带 `feature: 'page'`；四个键移出 `RESTART_KEYS`，改订阅 `ctx.aiProfiles` 里本页那一档的就绪状态 |
| `popup/popup.js` :28-32，:497-512，:552-554；`shared/engine-status.js` :97，:115-122 | 弹出窗口自己读四个键判断「没配 Key」（:552-554 `configureApiKeyFirst`）；`describeEngineStatus` :122 `isApiKeyMissing(settings)` | D1：问页面（`probe.aiReady`，§3.5） |
| 9 处请求字面量 | 整页 `content/page/batch.js` :425、:600、:658；字幕 `shared/caption-core.js` :433（`buildTranslationRequest`）；划词 `content/content-popup.js` :621；悬停 `content/content-hover-translation.js` :183；块内划词 `content/hover/selection.js` :265；输入框对话框 `content/content-input-dialog.js` :257；输入框芯片 `content/content-input-chip.js` :275（R33 新增） | D1：每处加 `feature`；`content/frames/top.js` :152-163 是转发，不算字面量 |
| 批量分隔符 5 处 | `content/page/batch.js` :33、`content/captions/state.js` :21（:142 导出）、`shared/caption-core.js` :436、`background/ai-translate.js` :229、`background/background.js` :396 | D1：收进 `shared/batch-delimiter.js`；内容侧不再传分隔符 |
| `content/page/batch.js` 失败点 | :399-408 快速批数量不符转逐条；:411 空译文跳过；:432-435 逐条出错 `continue`、:440 空译文 `continue`、:447 逐条 `onFailure`；:608-611 超长块出错、:615-617 数量不符；:628 任一块缺就整段放弃插入、:631 拼出来是空；:668 批次出错记 `noteBatchFailure`；:528 `MAX_BATCH_FAILURES = 3`；:546-554 `noteBatchFailure` | D2：每个失败点都落一个失败标记（§4）；`MAX_BATCH_FAILURES` 不动 |
| `content/page/visibility.js` :21-22，`content/css/translation.css` :192-238 | `PAGE_TRANSLATION_SELECTOR` 和 9 条样式选择器认 `.ai-translator-inline-block` | D2：加 `:not(.ai-translator-failed)` |
| `content/page/custom-rule.js` :79，:87，:270，:311-336 | `engineOverride()`、`domain()`；`profileSignature()` 只看这两个；shelf `ctx.customRules` 含 `inherit(engine)`、`onProfileChange` | D1：加 `profileOverride()`，`profileSignature` 与 `inherit` 一起带上它 |
| `content/frames/top.js` :62-63，:74-75；`content/frames/child.js` :192，:207 | 顶层指令带 `engineOverride`、`generation`；子帧 `ctx.customRules.inherit(next.engineOverride)` | D1：指令加 `profileOverride`，子帧照样继承 |
| `shared/custom-rules.js` :37，:142-190 | `VERSIONS = {1, 2}`；`validateRule` 按字段定最低版本（:155-156、:178-184） | D1：`VERSIONS` 加 3；`profile` 字段（§2.7） |
| `test/unit/helpers/sources.mjs` :215，:221-236 | `NON_PRODUCT_DIRS` 黑名单 + `readdirSync` 遍历磁盘（D-390：把别的会话留下的未跟踪副本当产品源码扫） | D1 第 0 步：只认 `git ls-files`（§10） |

## 2. 数据与存储（D1）

### 2.1 额度

B§2.1 额度表的「P1-D 配置档」一行从「预留」改成「本轮」：≤ 8 KiB、≤ 20 项。其他行不动。

### 2.2 配置档结构 v1

```js
{
  // id 只在键里：aiProfile:<id>（旧配置迁来的那一档固定是 aiProfile:legacy）
  v: 1,
  name: '工作用 Claude',            // 1–40 字符，去首尾空白；同名允许
  provider: 'anthropic',            // APICompat 的预设键之一，或 'custom'
  apiEndpoint: 'https://…',         // ≤ 512，http(s)，过 URL 解析
  apiKey: 'sk-…',                   // ≤ 1024；本地接口或 keyOptional 预设可以为空
  modelName: 'claude-sonnet-5',     // 1–128
  features: ['selection', 'input'], // AIProfiles.FEATURES 的子集，去重排序
  default: true,                    // 全部档里恰好一个为 true
  rpm: 0,                           // 0–600，0 = 不限
  concurrency: 0,                   // 0–32，0 = 不限
  timeoutSec: 120,                  // 15–240
  updatedAt: 1790000000000          // 写入时由 SW 填
}
```

- `FEATURES = ['page', 'selection', 'hover', 'input', 'subtitles', 'ocr']`，只有 `shared/ai-profiles.js` 这一份，设置页的分配表和请求字面量的扫描都读它。
- 未知字段写入时丢弃；`v > 1` 读取时跳过（同 B§2.2）。
- `DRAFT`：新建表单的初值，就是今天 `background/settings.js` :31-34 那四个值加上 `timeoutSec: 120`。它只用来填表，不是缺省配置；没有配置档就是没有配置档。

### 2.3 `shared/ai-profiles.js`（`globalThis.AIProfiles`，双模经典脚本）

| 成员 | 作用 |
|---|---|
| `FEATURES`、`DRAFT`、`LEGACY_ID = 'legacy'`、`LIMITS` | 常量 |
| `collection` | `SyncCollection.create({prefix: 'aiProfile:', decode, hosts: () => [], limits: {itemBytes: 2560, totalBytes: 8192, maxItems: 20}, errors: {tooLarge: 'aiProfileTooLarge', budgetFull: 'aiProfilesBudgetFull'}})`（`create` 的契约在 `shared/sync-collection.js` :74-77） |
| `validate(profile)` | 形状与长度；返回 i18n 键或 `null` |
| `validateSet(profiles)` | 集合规则：恰好一个默认档（集合为空时例外）；每个功能至多出现在一档里 |
| `resolve(profiles, {feature, ruleProfileId})` | §0.1-9 的优先级。返回 `{profile}`，或 `{error: 'aiProfileMissing', id}`（规则指向的档不在），或 `{error: 'aiNotConfigured'}`（一档都没有）。`feature` 不在 `FEATURES` 里就抛 `TypeError` |
| `publicView(profile)` | 给内容脚本的形状：`{id, name, provider, apiEndpoint, modelName, features, default, keyMissing}`，`keyMissing` 取 `APICompat.isApiKeyMissing(profile)` |
| `fromLegacy(settings)` | 旧四键 → 一档（`name` 取服务商预设的显示名，`features: []`，`default: true`）；四个键一个都没有时返回 `null` |

防抄写扫描同 B§2.6：`storage.onChanged`、`get(null)`、去抖计时器不准出现在本文件。

### 2.4 写：`AI_PROFILES_WRITE`（判别字段 `kind`，B§2.4）

| kind | 参数 | 结果 |
|---|---|---|
| `put` | `{profile}` | 新增或整档替换；`profile.default === true` 时其余档的 `default` 改成 `false`；`features` 里的功能从别的档上摘掉（同一次多键 `set`）；集合原本为空时这一档自动成为默认档；返回 `{id}` |
| `remove` | `{id}` | 被站点规则引用 → `aiProfileInUse`（带规则的 match 列表）；是默认档且还有别的档 → `aiProfileDefaultInUse`；否则删掉 |
| `import` | `{profiles, keepKeys}` | 按 id 合并（`SyncCollection.merge`，`shared/sync-collection.js` :166，键是 id）；某档没带 Key 而本机同 id 的档有 Key，保留本机的；合并后过 `validateSet`；返回 `{added, replaced}` |
| `migrateLegacy` | 无 | §2.6 |

错误以 i18n 键作为 `error` 返回，其余一律 `aiProfileSaveFailed`。每个 kind 都经 `collection.write(compute)`，额度检查只有 `assertFits` 一份。SW 侧的模块模式照 `background/custom-rules-host.js`（28 行）与 `background/glossary-host.js`（29 行）：一个 `StorageWriter.create({type, writes, errors})`（`shared/storage-writer.js` :52）加消息分派。

### 2.5 读

- **SW**：`AIProfiles.collection.cached()`，处理翻译消息时按 `profileId` 取整档（含 Key）；图片识别在 SW 里 `resolve(…, {feature: 'ocr'})`。
- **内容脚本（每个帧都建，解析只在顶层）**：`ctx.aiProfiles`（`content/content-ai-profiles.js`），`SyncCollection.mirror({request, host: null})`（`shared/sync-collection.js` :248）；`request` 发 `AI_PROFILES_PUBLIC`，SW 回 `publicView` 的数组；sync 增量经 `decode` 后也转成 `publicView`。镜像只问 SW、不问顶层，所以子帧也能回答「AI 配好没有」（划词卡片的「换引擎」在 iframe 里也会问，`content/content-popup.js` :560 → 引擎 :831）；但选档（`resolve`）只在顶层的送出口发生，子帧的请求经 relay 到顶层再解析（§3.2）。见 §3.3。
- **设置页**：`get(null)` → `collect`，带 Key（编辑表单要显示）。

### 2.6 迁移：旧四键 → `aiProfile:legacy`

- SW 里一个记住结果的 `ensureMigrated()`：`get(['provider', 'apiEndpoint', 'apiKey', 'modelName'])`，四个键里**存过任何一个**（包括只存了接口地址、没填 Key）就走写队列的 `migrateLegacy`：
  1. 集合里没有 `aiProfile:legacy` 时，写入 `fromLegacy(旧值)`；已有就不写（另一台设备先迁过了）。
  2. 同一次写之后 `remove` 四个旧键。
- 触发时机：`runtime.onInstalled`（更新）、`runtime.onStartup`，以及每个读配置档的 SW 入口先 `await ensureMigrated()`。失败就抛，由各入口按现有错误路径报出来，下次再试；不退回读旧键。
- 旧键的缺省值（`background/settings.js` :31-34）同一批删掉。没存过这四个键的用户（从没打开过 AI 设置）迁移后没有配置档，和今天「没填 Key」看到同一句提示。
- **兼容影响**（已交到用户手里的存储，写进 PR 描述与收官汇报）：
  - 同一账号下还没更新的设备，读不到四个旧键，AI 那一路会提示「未配置」，更新后恢复；
  - 不支持降级：退回旧版本会看到空的 AI 设置；
  - 迁移写入与另一台设备上正在编辑旧设置之间有 sync 传播时差，那次编辑可能被覆盖（§8）。

### 2.7 站点规则 v3：`profile`

- B§2.2 的规则加可选字段 `profile: '<id>'`。按 D-303 细化 7 与 `shared/custom-rules.js` :17-19 的「最低能表达它的那一版」规矩，用到它的规则写 `v: 3`（v2 是 C3 的 `domain`），没用到的仍按原来的最低版本写。`VERSIONS`（:37）加 3；`v: 3` 却没有 `profile` 是坏条目（同 :156 对 v2 的写法）。
- `validateRule`（:142）：`engine === 'builtin'` 时带 `profile` 拒绝（`customRuleProfileWithBuiltin`）；id 形状不对拒绝（认 `SyncCollection` 的 `ID_RE`）。SW 写规则时 id 必须存在于配置档集合（`customRuleProfileMissing`）。`:188` 的「空规则」判断把 `profile` 也算作一个有效字段。
- 内容侧：`ctx.customRules.profileOverride()`（`content/page/custom-rule.js` :311-336 的 shelf 上与 `engineOverride()` :79 并列）；`profileSignature()`（:270）把它算进去，`onProfileChange` 才会在规则换档时回调（缓存层的代数要靠它，§3.4）。`inherit(engine)` 扩成 `inherit(engine, profile)`，顶层指令（`content/frames/top.js` :62-63、比较 :74-75）加 `profileOverride`，子帧 `content/frames/child.js` :207 照样继承——子帧不解析配置档（§0.1-12），继承只为让 `onProfileChange` 的代数在子帧也跟着顶层走。

### 2.8 设置整份导入导出

- `shared/settings-transfer.js` 加 `aiProfiles` 一节，走 P0-F 的 section 契约（B§12.4 的 `collectionSection(spec)`，`options/options-transfer.js` :149），与站点规则、术语表同一个导入动词；`TRANSFER_SECTIONS`（:226）从四节变五节。
- 导出：勾了「包含 API Key」才带 `apiKey`；没勾就整档不带这个字段。这条规矩替掉 `SECRET_KEYS`（:44）。`PATTERNS.apiEndpoint`（:51）删掉，接口地址的校验归 `AIProfiles.validate`。
- 导入：
  - 新文件：`aiProfiles` 一节经 `AI_PROFILES_WRITE import`；没带 Key 的档保留本机同 id 档的 Key。
  - 旧文件（`settings` 一节里有四个旧键）：`fromLegacy` 转成一档，id 固定 `legacy`，并进同一次 `import`；预览行写「将新增 / 替换 1 个 AI 配置档」。四个旧键不再写回 `settings`。
  - 旧版本扩展导入新文件：不认识的 section 本来就忽略，AI 配置不导入，其余照常。

## 3. 请求链路（D1 为主，D2 加重试与限速）

### 3.1 每个请求标明功能

- 9 处字面量（§1 表）各加 `feature`：整页三处 `'page'`，字幕 `'subtitles'`（`shared/caption-core.js` :433 的 `buildTranslationRequest` 拼进去），划词卡片 `'selection'`（单词和整句两种模式都是，`content/content-popup.js` :624 的 `mode` 不影响它），悬停与块内划词 `'hover'`，输入框对话框与输入框芯片都是 `'input'`。
- 校验挂在解析上：`AIProfiles.resolve` 收到不在 `FEATURES` 里的 `feature` 就抛 `TypeError`（§2.3）。解析发生在 `ctx.sendTranslationCached`（缓存层 :162-169 那一步）和 `ctx.sendTranslation`（引擎 :778，`opts.profile` 没交时），两条路都经过它，缓存全命中的请求也在查缓存前校验过。子帧转发来的消息原样带着 `feature`（`content/frames/top.js` :161-163 不改消息）。
- 单测扫 `content/` 与 `shared/` 下所有 `type: 'TRANSLATE` 开头的对象字面量，每个都要有 `feature:`（字幕那一处在 `shared/`，只扫 `content/` 会漏）。

### 3.2 顶层解析与快照

- C§3.3 的快照今天是 `sendOpts = {glossary: snap, addendaSettings}`（`content/content-translation-cache.js` :162-169，D-384 F1 之后词表快照与领域、上下文开关同取一份），本轮扩成 `{glossary, addendaSettings, profile}`：`sendTranslationCached` 在 `await ctx.customRules.whenReady()`（:162）之后、取 `snap` 的同一段里加 `await ctx.aiProfiles.whenReady()` 与 `profile = ctx.aiProfiles.resolve(message.feature)`；这一次请求的缓存键（§3.4）、附加说明、发给谁出自同一次读取。`loadProfile()`（:30-48）与 :173-174 的「读不到就直发」删掉。
- 不经缓存层的请求（内置引擎生效时 :154-156 直接 `ctx.sendTranslation(message)`；悬停等直接调 `ctx.requestTranslation` 的入口）：`ctx.sendTranslation`（引擎 :778）的 `Promise.all`（:781-784）加 `ctx.aiProfiles && ctx.aiProfiles.whenReady()`，`opts.profile` 没交就在取 `snap`（:785）的同一行现解析。
- `resolve(feature)` 内部用 `ctx.customRules.profileOverride()`；只有 TRANSLATE 与批量类型才看站点规则（D-302 #5）。
- 走内置引擎的请求不需要配置档：解析照做（`{error}` 也照样放进 `opts.profile`），内置分支（引擎 :802-820）不看它；只有真要发给模型时（`sendToModel`，:678）才把 `{error}` 变成响应 `{error: 本地化文案}`——包括内置引擎回落到 AI 的那一路（:792 `mayFallBack`）。
- `sendToModel(original, snap, frozen, profile)`（第四个位置参数，§14 自决修-B）在出口前把 `profileId` 盖进消息（与 :686 取 `current` 同一处）；SW 不接受没有 `profileId` 的 TRANSLATE 类消息（抛，交给现有的消息错误路径）。
- D3 的流式只换 `sendToModel` 里的传输（`opts.onDelta` 存在就走端口，§5），不加解析点。

### 3.3 内容侧镜像：`ctx.aiProfiles`（`content/content-ai-profiles.js`，每个帧都建）

| 成员 | 作用 |
|---|---|
| `whenReady()` | 镜像首次就绪；1500 ms 没回话按 B§2.6 的 `whenReady` 规矩走 `failed`（`READY_CAP_MS`，`shared/sync-collection.js` :33） |
| `status()` | `'pending' \| 'ready' \| 'failed'` |
| `resolve(feature)` | `AIProfiles.resolve(entries, {feature, ruleProfileId: ctx.customRules.profileOverride()})`；`failed` 时抛 |
| `ready(feature)` | 解析得到一档且 `!keyMissing` |
| `subscribe(fn)` | 镜像变了就回调 |

替掉引擎文件里的：

- `AI_CONFIG_KEYS`、`refreshAiConfig`、`aiConfigured`（:429-443）。`refreshAiConfig` 读失败时把配置清空当成「没配」（:435-437），这正是要删的静默兜底。
- `canFallBackToAI`（:454-458）改成 `fallbackAllowed() && ctx.aiProfiles.ready(feature)`，`feature` 从消息里取。
- sync 监听里并 `aiConfig` 的那段（:528-541）。
- `engineChoices(targetLang)`（:831-837）加参数 `feature`：`ai: ctx.aiProfiles.ready(feature)`，:832 的 `refreshAiConfig()` 随之删。唯一调用方是划词卡片（`content/content-popup.js` :560），传 `'selection'`。
- `effectiveEngine({auto})`（:477-481）加 `feature`；`content/content-auto-translate.js` :396 的费用闸传 `'page'`。
- 设置页也加载引擎这一族（`options/options.html` :934-938），那里没有 `ctx.aiProfiles`：设置页只读 `builtinTranslator`（`options/options-builtin.js` :17），不发翻译请求；引擎文件里用 `ctx.aiProfiles` 的地方都在请求路径上，`ctx.aiProfiles` 缺席时这些函数抛，不做兜底（`sendTranslation` :781-784 的 `whenReady` 用与 `ctx.customRules` 同样的 `&&` 守卫，只是为了加载不炸）。

`RESTART_KEYS`（`content/content-auto-translate.js` :708-711）去掉 `provider`、`apiKey`、`apiEndpoint`、`modelName` 四个键（:711，它们迁移后就不存在了），改为订阅 `ctx.aiProfiles`：`ready('page')` 的结果变了才 `start('settings')`（与 :719-720 同一个入口）。`test/unit/auto-translate-wiring.test.mjs` 的对账改成认这条订阅。

### 3.4 缓存

- `shared/translation-cache.js` 的 `FACTORS`（:111，C1 之后是八个）不变。`endpoint` 和 `model` 两个因子的值取自快照里的配置档（`opts.profile.profile.apiEndpoint` / `.modelName`），替掉 `factors` 里的 `...profile` 展开（`content/content-translation-cache.js` :179-186）。
- `content/content-translation-cache.js`：`PROFILE_KEYS`（:16）只剩 `customPrompt`；`loadProfile`（:30-48）改名 `loadPrompt`、只读这一键，读失败就抛（§0.1-16）。`GENERATION_KEYS`（:69-72）去掉 `apiEndpoint`、`modelName`、`provider`。
- 内置引擎生效的请求本来就不经这一层（:154-156 直接 `ctx.sendTranslation`），配置档对它们只在回落到 AI 时才用到（§3.2）；C§3.7 的键规矩不变。
- C§3.8 `ctx.translationProfile.onSettingsChanged`（:121-124）的名单里去掉 `apiEndpoint`、`modelName`、`provider`，改订阅 `ctx.aiProfiles` 与 `ctx.customRules.onProfileChange`（:333，规则换档时它会回调，§2.7）：本页任一功能解析出的档的 `apiEndpoint` 或 `modelName` 变了才加一代。子帧经顶层指令的 `generation` 继承（`content/frames/child.js` :192），不改。
- C§11-1（缓存键不含服务商）关闭：§0.1-15。

### 3.5 弹出窗口

- `probeStatus`（引擎 :867-895，D1 第 0.5 步后在 `content/engine/probe.js`）的结果加 `aiReady = ctx.aiProfiles.ready('page')`（顶层按站点规则算）。
- `EngineStatus.selectedEngine(settings, probe)`（`shared/engine-status.js` :97）旁边加 `EngineStatus.aiReady(settings, probe)`：有 probe 用 `probe.aiReady`；probe 是 `null`（这一页没有内容脚本，如 chrome:// 或商店页）时，弹出窗口问 SW `AI_PROFILES_READY {feature: 'page'}`（不带站点规则）；探测超时（`EngineStatus.UNKNOWN_PROBE`，`popup/popup.js` :510）当作就绪，让真正的请求去报真实原因。
- `popup/popup.js` :552-554 的「先去填 Key」和 `shared/engine-status.js` :122（`describeEngineStatus` 里的 `isApiKeyMissing(settings)`）都改用它；`popup/popup.js` :28-32 读四个旧键的那段删掉。

### 3.6 SW：`background/model-client.js`

```js
callModel(profile, request, { signal, onDelta, feature })
// request = { system, user, maxTokens, stream }
// 返回 { text }；失败抛 Error，带 err.apiFailure（D-289 的形状）
```

- 请求体仍由 `callClaudeAPI` / `callOpenAIAPI`（`background/api-client.js` :59/:69）拼，按 `APICompat.isClaudeAPI(profile.apiEndpoint)`（`shared/api-compat.js` :106）选。
- 读响应仍由 `readAPIResponse`（:332）返回 `{text} | {failure}`（D-289），报错文案仍由 `describeAPIFailure(failure, t, {provider})`（:391）出。
- 失败分类加两种：`{timeout: true}`（`apiErrorTimeout`，文案带秒数）和 `{empty: true}`（`apiErrorEmpty`）。
- `background/ai-translate.js` 的五个入口（:103、:138、:173、:186、:229）参数从 `settings` 换成 `(profile, settings)`：`settings` 只剩 `customPrompt` 等提示词相关的键；:122/:133/:165-168 三处把空答案换成原文的写法删掉，改抛 `{empty: true}`。
- `background/ocr-recognize.js` 的 `recognizeWithVision`（:196）同样经 `callModel`，`feature: 'ocr'`。
- `AI_PROFILE_TEST {profile}`：设置页的测试连接，发一个最小请求，回 `{ok}` 或 `{error}`；用表单里还没保存的档，不入缓存、不计额度、不过限速。

### 3.7 超时

- 每次尝试一个 `AbortController`，`timeoutSec` 到了就 `abort`，失败记为 `{timeout: true}`。调用方传的 `signal`（流式端口断开）同样 `abort`，那种失败不重试、不报错给用户（没人在等了）。
- 流式请求的超时从「开始」算到「第一个字」，出字之后每两个增量之间不超过 `timeoutSec`。

### 3.8 SW 续命

- `background/keepalive.js`：引用计数。`callModel` 进来 `acquire()`、出去 `release()`；计数从 0 变 1 时起一个 20 秒的 `setInterval` 调 `chrome.runtime.getPlatformInfo()`，回到 0 就清掉。
- 依据：crawl-store #1119（SW 空闲 30 秒被回收；单次事件超过 5 分钟、或 `fetch` 响应 30 秒没到会被终止；扩展接口调用重置空闲计时）。超时上限 240 秒留出 60 秒余量。

### 3.9 重试（D2）

- 可重试：网络错误、超时、HTTP 429、500–599（含 Claude 的 529 与流中的 `overloaded_error` 事件，#1120）。不可重试：其余 4xx、空答案、解析失败、调用方取消。
- 至多 3 次尝试；第 2、3 次之前分别等 1 秒、2 秒，各乘 `0.8–1.2` 的随机因子。响应带 `Retry-After`（秒数或 HTTP 日期）就用它，超过 60 秒直接判失败（`apiErrorRateLimited`，文案带秒数）。
- 流式请求出过字之后不重试（卡片上已经有半句了），直接报错，卡片保留已出的字并在后面显示错误。
- 最后一次的失败原样抛；日志只在 SW 这一层打一次（原始错误、操作名 `callModel`、档 id、功能；不写 Key、不写请求体）。

### 3.10 限速（D2）：`background/model-limiter.js`

- 每档一个令牌：`acquire(profile)` 在并发数和每分钟请求数都有余量时放行，否则排队（先来先走）；每次尝试（含重试）各取一个令牌。
- 改了档的 `rpm` / `concurrency`，下一个 `acquire` 起按新值；删了的档，队列里的请求照完成。
- 计数在内存里，SW 被回收就清零（§8）。排队的时间计入该次尝试的超时之外（排队不算超时），但计入续命。

### 3.11 批量分隔符

- `shared/batch-delimiter.js`：`BATCH_DELIMITER = '⟪⟫⟪⟫⟪⟫'`，SW 与内容侧都加载。
- 内容侧（`content/page/batch.js` :33、`content/captions/state.js` :21 与 :142 的导出、`shared/caption-core.js` :436 的 `delimiter: opts.delimiter`）不再各自定义、不再随消息传；SW 的 `TRANSLATE_BATCH_FAST` 路由（`background/background.js` :141-145）不再转 `message.delimiter`，`handleBatchTranslateFast`（:396）不再收 `delimiter` 参数（`'|||'` 缺省随之删）；`background/ai-translate.js` :229 的缺省改读常量。
- `Glossary.validateEntry`（`shared/glossary.js` :119）今天只拒 `TextMarkers.hasMarkers`（:127），**本轮加**拒绝含分隔符的词条（C§11-2 留给本轮的那一条；C§7 最后一行），读这个常量。
- 单测扫描：`⟪⟫` 的字面量只准出现在 `shared/batch-delimiter.js` 和 `test/`。

### 3.12 删掉 `TRANSLATE_BATCH`

- `background/background.js` :135-139（路由）、:374-391（`handleBatchTranslate`）、引擎 :592 的 case；`BUILTIN_TYPES`（:569）去掉它。
- **`background/ai-translate.js` 的 `translateBatchWithAI`（:186）留下**：它是 `translateBatchFastWithAI` 在分隔符数量不符时的编号法回退（:277），不是只为 `TRANSLATE_BATCH` 存在的。
- 产品代码里没有发送方；三条单测还在发它，随消息改成 `TRANSLATE_BATCH_FAST`：`test/unit/prompt-register-engine.test.mjs` :74、:225；`test/unit/frame-relay-addenda.test.mjs` :216；`test/unit/auto-translate-wiring.test.mjs` :422（三种类型的循环收成两种）。`test/unit/site-engine-override.test.mjs` :134-137 对 `BUILTIN_TYPES` 的正则断言随名单改。
- B、C 两份设计里提到它的地方，在本 PR 的文档提交里改成两种类型。

## 4. 失败段落标记（D2）：`content/page/failed-blocks.js`（shelf `ctx.failedBlocks`）

- 元素：`<span class="ai-translator-inline-block ai-translator-failed" role="button" tabindex="0">`，文字「翻译失败 · 重试」（`translationFailedRetry`），`title` 是失败原因的本地化文案。插在这一段译文本该出现的位置，走 `content/page/insert.js` 现有的插入点。
- **不算译文**：`PAGE_TRANSLATION_SELECTOR`（`content/page/visibility.js` :21-22）加 `:not(.ai-translator-failed)`；`content/css/translation.css` 的 9 条选择器（:192、:197、:204、:210、:219、:227、:232、:233、:238）同加。`pairedTranslation` 不把失败标记当成配对的译文。收集、发现、划词按类名跳过它，照旧。
- **收起译文时一起收起**：`setTranslationsVisible(false)` 也隐藏失败标记；展开时恢复。
- **点它**：去掉标记，这一段按原来的功能（`page`）、原来的引擎重新走一次 `requestTranslationCached`（`content/page/batch.js` :39 的 `requestBatch` 同一条路），单段发；再失败就再放一个标记。键盘 Enter / 空格同效。
- **何时放**：
  - 手动整页：SW 重试完仍失败的那一刻。`content/page/batch.js` 的失败点（:411 空译文跳过、:432-435 / :440 / :447 逐条、:608-611 / :615-617 超长块、:628 / :631 拼段缺块、:668 批次出错）各调 `ctx.failedBlocks.mark(block, reason)`；:399-408 数量不符转逐条不算失败（逐条那一路会各自报）；:628 那处（多块拼成的段落缺了任一块）不再悄悄放弃，改为整段标失败。
  - 自动整页：挂在放弃那一刻（`content/content-auto-translate.js` :508-518 的 giveUp），第一次失败只进 `retried` 记账（:89），不放标记。
  - 内置引擎的批次返回空串，同样算这一段失败。
- `MAX_BATCH_FAILURES = 3`（:528）不动：连错三批仍判整页失败（`noteBatchFailure` :546-554）并走现有的整页报错；已经放下的失败标记留着。

## 5. 流式输出（D3）

- **范围**：划词卡片整句模式（`content/content-popup.js` :621 的 TRANSLATE，:624 `mode: isWord ? 'word' : 'text'` 取 `'text'` 时）和输入框翻译对话框（`content/content-input-dialog.js` :257，结果经 :233 `showResult` 显示在对话框里），只在顶层帧。子帧里的划词经 frame relay 到顶层执行，只拿最终结果。
- **不流式的输入框芯片**（R33，`content/content-input-chip.js` :274-275）：它的结果不显示，直接经 `ctx.inputWriteback.write`（`content/content-input-writeback.js` :174）一次写进输入控件，没有可以逐段追加的面；照常走 `ctx.requestTranslation`，只标 `feature: 'input'`（§14 自决修-C）。
- **通道**：内容脚本 `chrome.runtime.connect({name: 'model-stream'})`，发 `{message, profileId}`；SW 回 `{delta}` 若干条、最后 `{done, text}` 或 `{error}`。端口断开 = 调用方取消，SW `abort`。
- **流式不是第三个解析点**：两处入口只是多传 `opts.onDelta`；请求照样经 `ctx.sendTranslationCached` 取快照、查缓存，未命中才到 `sendToModel`（引擎 :678），`sendToModel` 见到 `onDelta` 就把 `chrome.runtime.sendMessage` 换成端口发送——`profileId` 是它在同一处盖上的那一个，解析点仍只有 §3.1 的两处（§14 自决修-J）。
- **只在未命中缓存时流式**：先照常查缓存，命中就直接给整句；没命中才开端口。最终的 `text` 照常写缓存。
- **解析**（`background/model-stream.js`，只解析文字增量）：
  - Claude（crawl-store #1120）：事件顺序 `message_start` → 若干内容块（`content_block_start` / `content_block_delta`（`text_delta`）/ `content_block_stop`）→ `message_delta` → `message_stop`；`ping` 忽略；`error` 事件按 §3.9 分类；不认识的事件类型忽略。
  - OpenAI 兼容（crawl-store #1121）：每块是 `chat.completion.chunk`，文字在 `choices[].delta.content`，带 `finish_reason` 的块表示结束；`data: [DONE]` 行容忍（#1121 的正文没写明，实测为准）。
  - 流在结束标志之前断开：已收的字不当成完整译文，按网络错误处理。
- **显示**：卡片和对话框的译文区域逐段追加；出第一个字前仍是现有的加载态。「复制」「换引擎」等动作在 `done` 之后才可用（J-D9 的动作行几何不变；`setCardActionsBusy`，`content/content-popup.js` :615）。
- 本地接口（`APICompat.isLocalEndpoint`，`shared/api-compat.js` :198）同样流式；服务不支持流式（回的不是 `text/event-stream`）时按普通响应读，一次给整句，不报错——这是服务的回答方式，不是回落。

## 6. 设置页（D1 建卡片文件，D4 补列表与分配）

- 「AI 服务」卡片：配置档列表（名称、服务商、模型、默认标记、Key 状态），每行「编辑 / 设为默认 / 删除」；「新建配置档」打开同一张表单，初值取 `AIProfiles.DRAFT`。表单里是今天的服务商、接口地址、Key、模型（沿用 `options/options-models.js` :11 `updateModelDropdown`、:59 `onProviderChange`、:112 `getEffectiveModelName`、:119 `detectProviderFromEndpoint`），外加每分钟请求数、并发数、超时三个数字，「测试连接」按钮（§3.6）。
- 「按功能分配」表：六行功能，每行一个下拉「默认（<默认档名>）/ 各档」。改一行就是一次 `put`（把功能挂到目标档上，从原来的档摘下）。
- 站点规则表单（B2 的 `options/options-custom-rules.js`，563 行）加「AI 配置档」下拉：「跟随功能分配」+ 各档；规则引擎选了内置时禁用并清空。
- 删除被引用的档：错误行列出引用它的规则，不弹确认框。
- 引导页（`onboarding/onboarding.js` :185-199）：选服务商那一步改成建 / 更新默认档。
- 1k 行：`options/options.js` 今天 925 行、`options/options.html` 973 行。**D1** 就把「AI 服务」卡片搬进新文件 `options/options-ai-profiles.js`（D1 已经要改 :39-44、:148-151、:226-249、:374-384、:633-635、:652、:721、:737 这些读旧键的段落，搬迁与改动同一批做，不留一半在 `options.js`），`options.js` 只接线，净减约 70 行；D4 的列表与分配表由 `options-ai-profiles.js` 渲染，`options.html` 只加两个容器，表单标记（今天 :100-160 一带）改成 `<template>` 留在原处不增行。D4 完成后两个文件都要 `wc -l` 复核在 1000 以下（§10）。

## 7. 验收：旅程、承诺与单测

验收以旅程为单元，结论只有「步骤 N 一致 / 偏差」。夹具只用来隔离子步骤，每处都标 `[fixture]`；入口一律走真实界面。

**测试台要补的**（`test/e2e/mock-openai-server.js`）：

- `stream: true` 的请求回 `text/event-stream`，按 OpenAI 的 chunk 格式逐字推，可设每块间隔；另开一个 Claude 路径（`/v1/messages`）按 #1120 的事件推。
- 选项 `rateLimit: {count, retryAfter}`：前 `count` 次回 429 并带 `Retry-After`。
- 选项 `hangMs`：收到请求后不回话，用来测超时。
- 按路径记请求（多个配置档指向同一个 mock 的不同路径，如 `/a/v1/chat/completions`、`/b/v1/chat/completions`），旅程据此断言请求去了哪一档。

### 7.1 旅程

| 旅程 | 步骤与用户动作 | 可观察结果 |
|---|---|---|
| **D-J1** 旧配置迁移 | 1. `[fixture]` 以旧版本的存储启动（四个旧键有值，含 Key）。2. 打开设置页。3. 整页翻译 | 2. 列表里一档「OpenAI」，是默认档，接口地址、模型、Key 与旧值相同；sync 里四个旧键已不存在，`aiProfile:legacy` 存在。3. 请求打到这一档的地址 |
| **D-J2** 新建与默认 | 1. 新建第二档（mock 路径 /b），设为默认。2. 整页翻译 | 1. 第一档的默认标记消失。2. 请求去 /b |
| **D-J3** 按功能分配 | 1. 「按功能分配」里把划词指到 /b 档，其余默认（/a）。2. 整页翻译。3. 划一句话 | 2. 整页请求去 /a。3. 划词请求去 /b |
| **D-J4** 按站点 | 1. 给本站加一条规则，AI 配置档选 /b。2. 整页翻译；划词；悬停。3. 换到规则不管的另一页整页翻译 | 2. 三种请求都去 /b。3. 去 /a |
| **D-J5** 删除保护 | 1. 删 D-J4 规则引用的档。2. 删默认档（还有别的档）。3. 删到只剩一档后删它，再整页翻译 | 1. 错误行列出那条规则，档还在。2. 提示先设别的默认档。3. 弹出窗口与页面给「未配置 AI」的同一句提示 |
| **D-J6** 超时 | 1. 档的超时设 15 秒，mock `hangMs` 30 秒。2. 划一句话 | 2. 三次尝试各在 15 秒上被掐断（中间隔 1 秒、2 秒退避，mock 收到 3 次），约 48 秒后卡片显示「请求超时（15 秒）」，不是一直转圈；SW 日志只有一条 |
| **D-J7** 429 重试 | 1. mock 前 2 次回 429、`Retry-After: 3`。2. 划一句话 | 2. 卡片最终出译文；mock 收到 3 次请求，相邻间隔 ≥ 2.9 秒（与 1 秒 / 2 秒的普通退避分得开） |
| **D-J8** 不可重试 | 1. mock `status: 401`。2. 划一句话 | 2. mock 只收到 1 次；卡片显示 Key 无效的文案 |
| **D-J9** 限速 | 1. 档的并发设 1、每分钟 600。2. 整页翻译一个多段落的 `[fixture]` 页 | 2. mock 记录的同时在途请求数最大为 1 |
| **D-J10** 失败段落 | 1. mock `failWhen` 让含某句的批次失败。2. 整页翻译。3. 点「翻译失败 · 重试」前把 mock 改回正常。4. 点悬浮球收起译文 | 2. 那一段出现失败标记，其余段落有译文。3. 标记消失，这一段出译文，mock 只收到这一段。4. 译文与失败标记一起收起；再点展开，一起回来 |
| **D-J11** 只剩失败 | 1. mock 让所有批次失败。2. 整页翻译。3. 点悬浮球 | 2. 每段都是失败标记（在三批上限内），整页报错照旧。3. 悬浮球是「翻译」而不是「收起译文」，点了重新请求 |
| **D-J12** 自动翻译的第二次机会 | 1. 开自动翻译，mock 让某段第一次失败、第二次成功。2. 打开页面。3. 再让它两次都失败 | 2. 这一段最终有译文，从未出现失败标记。3. 第二次失败后才出现失败标记 |
| **D-J13** 流式：划词卡片 | 1. mock 按 50 ms 一块推 10 块。2. 划一句话。3. 同一句再划一次 | 2. 卡片译文区在 `done` 之前已出现部分文字（第一块后 ≤ 300 ms），最终文字与整句相同；动作行几何断言照样通过。3. 命中缓存，不开端口，一次给整句 |
| **D-J14** 流式：输入框与单词模式 | 1. 输入框对话框翻译一句（Claude 路径的档）。2. 划一个单词。3. 在 `[fixture]` 的输入框里用芯片翻译一句 | 1. 逐段出字，最终与整句相同。2. 单词释义不流式：mock 收到的请求不带 `stream`。3. 芯片一次回写整句，mock 收到的请求不带 `stream`，请求走 `input` 分配的档 |
| **D-J15** 导入导出 | 1. 设置整份导出（不勾 Key）。2. 删掉一档后导入。3. 导入一份 `[fixture]` 旧格式文件（`settings` 里有四个旧键） | 1. 文件有 `aiProfiles` 一节，没有 `apiKey` 字段。2. 预览「将新增 1 个 AI 配置档」；导入后那一档回来，Key 沿用本机同 id 的档（被删的那档没有 Key 可沿用，显示「未填 Key」）。3. 预览「将新增 / 替换 1 个」，导入后出现 `legacy` 档，Key 与文件相同 |

### 7.2 承诺即断言

| 文案 | 断言 |
|---|---|
| 「请求超时（N 秒）」 | D-J6：计时与档的 `timeoutSec` 一致 |
| 「会自动重试」（设置页限速说明） | D-J7：mock 收到的次数 |
| 「翻译失败 · 重试」 | D-J10：点了只重译这一段且成功后标记消失 |
| 「跟随功能分配」 | D-J4 步骤 3：规则不管的页面按功能分配走 |
| 「被站点规则使用，不能删除」 | D-J5 步骤 1：存储里档还在 |
| 「不包含 API Key」（导出勾选说明） | D-J15 步骤 1：文件里没有 `apiKey` |

### 7.3 单测

| 模块 | 钉住的行为 |
|---|---|
| `test/unit/helpers/sources.mjs`（D1 第 0 步） | `productSourceFiles()` 只认 `git ls-files`：变异证明——在仓库里放一份未跟踪的 `.claude/worktrees/x/content/…` 副本（临时目录，测完删），旧实现红、新实现绿（D-390） |
| `shared/ai-profiles.js` | `validate` 各字段上下限；`validateSet` 默认档恰好一个、功能不重复；`resolve` 三级优先级与两种错误、未知功能抛；`publicView` 不含 `apiKey`；`fromLegacy` 四键全空返回 `null` |
| 写队列 | `put` 设默认会摘掉别的默认、挂功能会从别的档摘；`remove` 两种拒绝；`import` 保留本机 Key；`migrateLegacy` 幂等、已有 `legacy` 不覆盖、删四键 |
| 快照一致（D-384 F1 的写法） | `readL2` 挂起期间把默认档的 `modelName` 改掉，断言送出的 `profileId` / 键里的 `model` 与取快照那一刻一致（改前须红），附变异 |
| `callModel` | 超时抛 `{timeout}`；空答案抛 `{empty}`；可重试 / 不可重试分类；`Retry-After` 秒数与日期两种写法、超过 60 秒不等；抖动在 ±20% 内；流式出字后不重试 |
| 限速器 | 并发上限、每分钟上限、改值即生效 |
| 续命 | 引用计数 0→1 起计时、回到 0 清掉；重叠请求只有一个计时器 |
| 流解析 | #1120 的示例事件序列拼出 "Hello!"；`ping` 与未知事件忽略；`error` 事件分类；OpenAI chunk 与 `[DONE]`；结束前断开判网络错误 |
| 请求字面量扫描 | `content/` 与 `shared/` 下每个 `type: 'TRANSLATE…'` 字面量都带 `feature:`（读 `productSourceFiles()`）；`resolve` 缺 `feature` 抛 |
| 分隔符扫描 | `⟪⟫` 只在 `shared/batch-delimiter.js` 与 `test/` |
| 旧键扫描 | `apiEndpoint` / `modelName` / `apiKey` 作为 `storage.sync` 的键名只出现在 `shared/ai-profiles.js`（`fromLegacy`）、迁移、`shared/settings-transfer.js`（旧文件转换）里 |
| 失败标记 | `PAGE_TRANSLATION_SELECTOR` 与 9 条 CSS 选择器都带 `:not(.ai-translator-failed)`；`pairedTranslation` 不配对标记 |
| 加载顺序 | manifest（:113 `sync-collection` 之后加 `shared/ai-profiles.js`，:131-135 引擎一族之前加 `content/content-ai-profiles.js`）、`options.html`（:919 之后、:934-938 之前）、`test/unit/helpers/engine-harness.mjs`（:112-130 的 import 串）、`test/e2e/helpers.js` 的 `PAGE_TRANSLATION_MODULES`（:50-）含新文件且顺序一致（写法同 C§6.3）；manifest 无重复路径（D-384 F2 的那条守卫照旧） |
| i18n | 十种语言都有 §9 的全部键 |

### 7.4 实测（不进门禁）

`test/measure/model-stream/`：对真实的 Claude 与 OpenAI 兼容接口各跑 20 句划词，记首字时间与整句时间，数字写进 PR 描述。需要用户自己的 Key，由用户在本机跑；PR 描述写明是否跑过。

## 8. 已知限制

| 限制 | 表现 | 为什么接受 |
|---|---|---|
| 未更新的设备 | 同账号下还没更新的设备读不到旧四键，AI 提示未配置 | 迁移后旧键必须删，不留双读（§0.1-17）；更新即恢复 |
| 不能降级 | 退回旧版本看到空的 AI 设置 | 同上 |
| 迁移与编辑的时差 | 迁移写入后，另一台旧版本设备上在 sync 传播期间保存的旧键会被下一次迁移忽略（`legacy` 已存在） | 窗口是秒级；保存 `legacy` 时不覆盖是为了多设备只得一档 |
| 限速计数在内存 | SW 被回收后计数清零，那一分钟可能略超 | 被回收说明空闲了 30 秒以上，超出量有限 |
| 超时上限 240 秒 | 很慢的本地大模型整页批次可能超时 | Chrome 后台单次事件 5 分钟上限（#1119） |
| 流式只在顶层 | iframe 里划词要等整句 | 端口跨不过 frame relay（§0.1-23） |
| 输入框芯片不流式 | 芯片翻译一次回写整句 | 回写面没有逐段追加的显示（§0.1-23） |
| 按功能分配不分语言 | 不能「译成日文用 A 档、译成中文用 B 档」 | 没有对标需求；以后加在 `resolve` 里 |
| 子帧「换引擎」按子帧自己的镜像答 | C§11-3 说的那条不一致仍在（子帧读的是 SW 镜像，与顶层同源，只差 sync 时序） | 本轮不动 C§11-3 |

## 9. i18n 键（十种语言，各语言词典里新开 `// AI profiles (P1-D)` 段）

| 键 | 用途 |
|---|---|
| `aiProfilesTitle` / `aiProfilesDesc` / `aiProfileNew` / `aiProfileEdit` / `aiProfileDelete` / `aiProfileSetDefault` / `aiProfileDefaultBadge` / `aiProfileKeyMissing` / `aiProfileName` / `aiProfileRpm` / `aiProfileConcurrency` / `aiProfileTimeout` / `aiProfileLimitsHint` / `aiProfileUsage`（`{kib}` `{count}`） | 卡片与表单 |
| `aiFeatureTitle` / `aiFeatureDefault`（`{name}`）/ `aiFeaturePage` / `aiFeatureSelection` / `aiFeatureHover` / `aiFeatureInput` / `aiFeatureSubtitles` / `aiFeatureOcr` | 按功能分配表 |
| `customRuleProfile` / `customRuleProfileFollow` / `customRuleProfileWithBuiltin` / `customRuleProfileMissing` | 站点规则表单 |
| `aiProfileInUse`（`{rules}`）/ `aiProfileDefaultInUse` / `aiProfileTooLarge` / `aiProfilesBudgetFull` / `aiProfileInvalid` / `aiProfileSaveFailed` / `aiProfileMissing`（`{name}`）/ `aiNotConfigured` | 错误 |
| `apiErrorTimeout`（`{seconds}`）/ `apiErrorEmpty` / `apiErrorRateLimited`（`{seconds}`） | 请求失败 |
| `translationFailedRetry` | 失败段落标记 |
| `transferSectionAiProfiles` / `transferPreviewAiProfiles`（`{added}` `{replaced}`） | 整份导入导出 |

## 10. 新文件与分批

**D1 第 0 步（主控已裁定，D-390 / B-P1C-WALK，原样执行）**：`test/unit/helpers/sources.mjs` 的 `productSourceFiles()`（:221-236）改为只认 `git ls-files` 列出的已跟踪文件（`execFileSync('git', ['-C', ROOT, 'ls-files', '-z'])`，保留 `.(m?js|html)$` 过滤与排序），删掉 `NON_PRODUCT_DIRS` 黑名单（:215）与 `readdirSync` / `statSync` 遍历；单一路径，不留开关。原因：黑名单不排除 `.claude/`，别的会话留在主树里的未跟踪 `.claude/worktrees/*` 副本被当成产品源码，`text-markers.test.mjs` 的两条扫描守卫在主树误报（D-390）。三个消费者不改：`test/unit/settings-transfer.test.mjs`、`test/unit/text-markers.test.mjs`、`test/unit/auto-translate-wiring.test.mjs`。变异证明见 §7.3 第一行。不动别的会话的 `.claude/worktrees/*`。

**D1 第 0.5 步（1k 行预拆）**：`content/content-translation-engine.js` 今天 978 行；D1 删 :429-458 与 :528-541（约 44 行）、加 `whenReady` / `feature` / `profile` 穿线（约 30 行）后仍在 950 行上下，D3 与后续任何补丁都会顶破。先把 :860-978（`withinBudget`、`probeStatus`、`ctx.builtinTranslator`，约 119 行）原样搬到 `content/engine/probe.js`（manifest 与 `options.html` 都在 `content-translation-engine.js` 之后加载，两个测试台同加）；它们用到的引擎内部谓词（`effectiveEngine`、`isBuiltinSupported` 等，名单以搬迁时实际引用为准）由引擎文件挂到 `ctx.engine` 上暴露，不复制实现。搬迁是纯位移，用 `test/unit/engine-pin.test.mjs`、`engine-target-unsupported.test.mjs` 等现有用例证明行为不变。之后引擎文件约 845 行。

| 文件 | 批 | 加载位置 |
|---|---|---|
| `content/engine/probe.js`（第 0.5 步） | D1 | manifest :135 之后；`options.html` :938 之后；两个测试台 |
| `shared/ai-profiles.js` | D1 | SW（B1 的 `sync-collection` 之后）；manifest（:113 之后）；`options.html`（:919 之后）；两个测试台 |
| `shared/batch-delimiter.js` | D1 | SW；manifest（`shared/caption-core.js` :103 之前——它在 `buildTranslationRequest` 里用得到，`content/page/batch.js` :154 与 `content/captions/state.js` :142 随之） |
| `background/model-client.js`、`background/keepalive.js` | D1 | SW |
| `background/ai-profiles-host.js`（写队列、`AI_PROFILES_PUBLIC`、`AI_PROFILES_READY`、`AI_PROFILE_TEST`、迁移） | D1 | SW |
| `content/content-ai-profiles.js` | D1 | manifest（引擎一族 :131 之前、`shared/ai-profiles.js` 之后） |
| `options/options-ai-profiles.js` | D1（卡片）、D4（列表、分配表） | `options.html`（`options-transfer.js` :970 之前） |
| `background/model-limiter.js` | D2 | SW |
| `content/page/failed-blocks.js` | D2 | manifest（`content/page/insert.js` :160 之后、`visibility.js` :161 之前；`batch.js` :154 在它之前加载但只在调用时读 `ctx.failedBlocks`） |
| `background/model-stream.js` | D3 | SW |

- 引擎一族（manifest :131-135、`options.html` :934-938）的依赖有新文件时两处同加（CLAUDE.md「Engine family」）。
- 1k 行台账（e29ab84 今天的行数 → 预计）：`content/content-translation-engine.js` 978 → 约 845（第 0.5 步）；`options/options.js` 925 → 约 855（D1 搬卡片）；`options/options.html` 973 → ≤ 990（D4 只加容器，须 `wc -l` 复核）；`content/content-auto-translate.js` 769、`content/page/batch.js` 708、`content/content-popup.js` 679、`options/options-custom-rules.js` 563、`shared/api-compat.js` 552 都有余量；`background/background.js` 413 删 `TRANSLATE_BATCH` 后更短；`background/ai-translate.js` 348 不删 `translateBatchWithAI`，只改参数，不增。
- 四批串行，每批一个本地提交，都进 `feat/p1-d-engine-layer` 这一个 PR；每批 diff 以约 1500 行为上限参考。D1 的文件集：§1 表里标 D1 的全部文件 + 上表 D1 新文件 + `manifest.json`、`options/options.html`、两个测试台、三条改 `TRANSLATE_BATCH` 的单测、十种语言词典；D2：`content/page/batch.js`、`content/page/visibility.js`、`content/css/translation.css`、`content/content-auto-translate.js`、`content/page/insert.js`、新 `failed-blocks.js`、`model-limiter.js`、`model-client.js`（重试）；D3：`content/content-popup.js`、`content/content-input-dialog.js`、`model-stream.js`、`model-client.js`（流式）、`mock-openai-server.js`；D4：`options/options-ai-profiles.js`、`options/options-custom-rules.js`、`shared/custom-rules.js`（表单侧）、`options/options.html`。`model-client.js` 在 D1/D2/D3 都改，是串行的原因之一。

## 11. 门禁（原文照抄，`<W>` 是 worktree 的绝对路径）

```bash
npm --prefix <W> run test:unit > <log> 2>&1; echo "GATE unit exit=$?"
npm --prefix <W> run test:e2e > <log> 2>&1; echo "GATE e2e exit=$?"
```

- 按 `GATE ... exit=` 那一行和日志里 ✘ 的个数判定，不接 `tail`、`head` 之类的管道。
- e2e 全量约 18 分钟，超过工具的超时，用 `nohup sh -c "...; echo \"GATE e2e exit=\$?\" >> <log>" > /dev/null 2>&1 &` 脱离后台跑，跑完读日志。
- 已知偶发：`test/e2e/selection-popup-pronunciation.spec.js` 和 `test/e2e/hover-translation.spec.js` 连真实的 `https://example.com`，网络抖动时 `page.goto` 报 `net::ERR_ABORTED`。遇到时单独重跑这个文件三次，全过就记为偶发并附日志。
- D1 第 0 步落地后，单测在带未跟踪副本的主树里也应绿；验收时在主树跑一次 `test:unit` 作为 D-390 的复验。

## 12. 登记待办（本期不做）

1. 机器翻译服务商（DeepL、Google、微软等）适配：用户裁定不做（D-316）。
2. 按目标语言分配配置档（§8）。
3. 每档一份自定义提示词。
4. iframe 里的划词流式输出（§8）。
5. 限速计数跨 SW 生命周期持久化（§8）。
6. 输入框芯片的流式回写（§8）。
7. C§11-3 子帧「换引擎」与顶层不一致（§8）。

## 13. 交接缝

1. **P1-B（已合入 #115）**：用 `SyncCollection`（`create` :74、`merge` :166、`mirror` :248）、`StorageWriter.create`（`shared/storage-writer.js` :52）、SW 分派表的写消息组（`background/background.js` :178-182）、`ctx.customRules`（`content/page/custom-rule.js` :311-336，加 `profileOverride()`，`profileSignature` :270 与 `inherit` 一起带上）、顶层指令（`content/frames/top.js` :62-63 加 `profileOverride`）、`EngineStatus.selectedEngine`（:97）；D4 往 B2 的 `options/options-custom-rules.js` 加下拉；规则 v3 的写法照 B§2.2、`shared/custom-rules.js` :17-19 与 D-303 细化 7。删 `TRANSLATE_BATCH` 要改 `BUILTIN_TYPES`（引擎 :569）与 `test/unit/site-engine-override.test.mjs` :134-137（§3.12）。
2. **P1-C（已合入 #119）**：快照（C§3.3，今天 `content/content-translation-cache.js` :162-169 的 `{glossary, addendaSettings}`）扩成 `{glossary, addendaSettings, profile}`，D-384 F1「键、附加说明、送出同一次读取」的口径延伸到配置档；`sendToModel`（C§3.4，引擎 :678）加第四个参数并盖 `profileId`；C§3.8 的代数名单（:69-72、:121-124）去掉三键、改订阅 `ctx.aiProfiles` 与 `onProfileChange`；C§11-1、C§11-2 在本 PR 关闭（后者要在 `shared/glossary.js` :119 `validateEntry` 里加分隔符拒绝）；C§11-3 不动。附加说明本身（`content/engine/addenda.js` :126 `settings()`、:169 戳）不改。
3. **R33（已合入 #118）**：输入框芯片（`content/content-input-chip.js` :274-275）是第 9 处请求字面量，标 `feature: 'input'`、不流式（§5）；它的 `catch` 用 `ctx.thrownTranslationMessage`（D-384 F4）不动。语域 `register`（`ctx.withPromptAddenda`，引擎 :747-756）与配置档无关，不动。
4. **P0-A 的「没配 Key」路径**（`missingApiKeyMessage` :26-30、`apiErrorMessage` :41-47、弹出窗口 :552-554 的拦截）：行为不变，数据来源从全局键换成解析出的档。
5. **P0 的划词卡片**（`content/content-popup.js`）：流式只改译文区的填法，守 J-D9 的动作行几何断言和 `fitLabel` 定宽规矩；「换引擎」「复制」在 `done` 之后可用（`setCardActionsBusy` :615）。
6. **设置迁移（P0-F）**：只按 B§12.4 的接口加一节（`options/options-transfer.js` :149 `collectionSection`、:226 `TRANSFER_SECTIONS`），并在 `settings` 一节（:48-95）的导入里加旧四键的转换；不改 `pickExport`（`shared/settings-transfer.js` :124）、`valueOk`（:134）、`validateSettings`（:154）的逻辑。

## 14. 对锚修订（e29ab84）

对锚方法：把 §0–§13 每一处 `file:line` 按 `e29ab84` 逐条 grep 核对；P1-B（#115）、R33（#118）、P1-C（#119）合入后改动的接缝重新读源码。下表「原文」指 2026-09-26 版（基线 e6b003b）的说法。

| 编号 | 原文 | 现状（file:line，e29ab84） | 改成 | 依据 |
|---|---|---|---|---|
| 修-1 | 头部：基线 e6b003b、「P1-B、P1-C 合入后，任务书按合入后的 main 重新对锚」、「排在 P1-B、P1-C 之后」 | `origin/main@e29ab84` 已含 #115/#118/#119 | 基线与行号口径改 e29ab84；删那句；交付段改「已合入，D1 直接用」 | 任务要求 |
| 修-2 | §0、§1、§2.2、§2.6：`background/settings.js` :29-32 | 缺省在 :31-34 | 行号 | grep |
| 修-3 | §0、§1：`background/api-client.js` :28-49、:58、:68、:100 | `callTranslationAPI` :29-50、`callClaudeAPI` :59、`callOpenAIAPI` :69、`countCharsSentToModel` :101 | 行号 | grep |
| 修-4 | §0：整页跳过失败段落 :384、:576 | 空译文跳过 :411；拼段缺块放弃 :628 | 行号 | `content/page/batch.js` |
| 修-5 | §0.1-6：`shared/api-compat.js` :216-221 | `requiresApiKey` :216-221、`isApiKeyMissing` :224、`describeAPIFailure` :391 | 补 :224/:391 | grep |
| 修-6 | §0.1-12、§0 生效点、§3.1：「选哪一档在顶层帧的 `ctx.requestTranslation` 里定」「`requestTranslation` 开头校验 `feature`」 | `ctx.requestTranslation`（引擎 :760-762）只是盖语域 + `sendTranslation`；子帧请求经 `content/frames/top.js` :152-163 直接进 `ctx.sendTranslationCached` / `ctx.sendTranslation`，不经 `requestTranslation` | 解析挂在 `ctx.sendTranslationCached`（缓存层 :162-169）与 `ctx.sendTranslation`（引擎 :778），校验由 `resolve` 抛 | 挂在 `requestTranslation` 上会漏掉全部子帧请求 |
| 修-7 | §0.1-13、§1、§3.1、§7.3：「8 处请求字面量分在 6 个文件」，字幕在 `content/captions/core.js` :433，`content/frames/top.js` :128 转发；单测只扫 `content/` | 9 处 7 个文件：`content/content-input-chip.js` :275（R33 新增）；字幕在 `shared/caption-core.js` :433；转发在 `content/frames/top.js` :152-163；其余行号见 §1 | 9 处；扫描范围加 `shared/` | grep `type: 'TRANSLATE` |
| 修-8 | §0.1-16、§1、§3.4：缓存层 :42-47 吞掉读取失败 | `loadProfile` 的 catch 在 :39-45，:173-174 读不到就直发 | 行号，补 :173-174 | `content/content-translation-cache.js` |
| 修-9 | §0.1-18、§1、§2.8：`SECRET_KEYS` :42、`PATTERNS.apiEndpoint` :49 | :44、:51 | 行号 | `shared/settings-transfer.js` |
| 修-10 | §0.1-20、§1：`result \|\| text` 在 :106/:117；「单词失败退回整句」:152-154 | :122/:133；单词模式是 :165-168 `parsed.translation = text.trim()`（空答案填回原文），没有退回整句的路径 | 三处都归「空答案当译文」，一起改抛 `{empty}` | `background/ai-translate.js` |
| 修-11 | §0.1-25、§1、§4：自动翻译记账 :96-100、放弃 :594-607 | `retried` :89、giveUp :508-518、`retried.clear()` :581 | 行号 | `content/content-auto-translate.js` |
| 修-12 | §0.1-26、§1、§3.12、§10、§13：删 `TRANSLATE_BATCH` 连带删 `translateBatchWithAI`（:171）；路由 :100-104、处理函数 :332-348、引擎 case :544 | 路由 :135-139、`handleBatchTranslate` :374-391、引擎 case :592、`BUILTIN_TYPES` :569；**`translateBatchWithAI`（:186）是 `translateBatchFastWithAI` 数量不符时的回退（:277）**；产品代码无发送方，三条单测发它（`prompt-register-engine.test.mjs` :74/:225、`frame-relay-addenda.test.mjs` :216、`auto-translate-wiring.test.mjs` :422） | 只删路由、处理函数、case、名单；`translateBatchWithAI` 留；三条单测改发 `TRANSLATE_BATCH_FAST` | 删了回退，快速批对齐失败时无路可走 |
| 修-13 | §0.1-27、§1、§3.11：分隔符 4 处，`ai-translate.js` :215、`background.js` :351 | 5 处：`page/batch.js` :33、`captions/state.js` :21（:142 导出）、`shared/caption-core.js` :436 随消息传、`ai-translate.js` :229、`background.js` :396（路由 :141-145 转 `message.delimiter`） | 5 处 | grep |
| 修-14 | §0.1-28：B§3.7 弹出窗口总是探测 | `popup/popup.js` :507-512 `refreshEngineStatus` | 补行号 | grep |
| 修-15 | §1：`background/background.js` :94-110、:313-367 | 路由 :129-145；处理函数 :356-411；三处 `sync.get` :357/:377/:397、`missingApiKeyMessage` :359/:379/:399、`PromptAddenda.validate` :365/:385/:405（R33 加的） | 行号 | grep |
| 修-16 | §1、§3.6：`ai-translate.js` :89-335，8 处传 Key，五个入口 :89/:122/:158/:171/:215 | :103-346；10 处传 Key；入口 :103/:138/:173/:186/:229 | 行号 | grep |
| 修-17 | §1、§3.6：`ocr-recognize.js` :196-222（:206-218） | `recognizeWithVision` :196，字段 :208-210、:217-219，调用 :264 | 行号 | grep |
| 修-18 | §1：`api-errors.js` :26-30 | `missingApiKeyMessage` :26-30、`apiErrorMessage` :41-47 | 补后者，同样收档 | grep |
| 修-19 | §1、§0.1-19：`options-connection.js` :20-23、:41-96、:79 | `formConnection` :17-23、`testConnection` :39-97、`fetch` :79 | 行号 | grep |
| 修-20 | §1、§6：`options.js` :40/:42、:134-135、:215-235、:358、:579-580、:598；870 行 | :39-44、:148-151、:226-249、:374-384、:633-635、:652、:721、:737；925 行；`options-models.js` :11/:59/:112/:119 | 行号；卡片搬迁提前到 D1 | grep、`wc -l` |
| 修-21 | §1、§6：`onboarding.js` :184-198 | `aiPatch` :185-196、`chooseAiProvider` :198-199、接线 :250-251 | 行号 | grep |
| 修-22 | §1、§2.8：`options-transfer.js` :83-84 | :83-84 不变；`settingsSection` :48-95、`collectionSection` :149、`TRANSFER_SECTIONS` :226（P1-C 加了术语表一节，共四节） | 补锚点；「加第五节」 | grep |
| 修-23 | §1、§3.3：引擎 :396-418、:402-404、:414-418、:486-499、:684-690 | `AI_CONFIG_KEYS` :429、`refreshAiConfig` :432-439（清空 :435-437）、`aiConfigured` :441、`fallbackAllowed` :450、`canFallBackToAI` :454-458、sync 合并 :528-541、`engineChoices` :831-837（:832 调 `refreshAiConfig`）、`effectiveEngine` :477-481 | 行号 | grep |
| 修-24 | §1：引擎 :630-676 `requestTranslation`；:667-675 唯一出口 | `withPromptAddenda` :747、`requestTranslation` :760-762、`sendTranslation` :778-823、`sendToModel(original, snap, frozen)` :678-707（:686 `frozen \|\| eng.addenda.settings()`，:822 传 `opts.addendaSettings`） | 行号；出口签名已是三参 | grep |
| 修-25 | §1、§3.5：`probeStatus` :715-726 | :867-895；`ctx.builtinTranslator` :900-978 | 行号；第 0.5 步搬到 `content/engine/probe.js` | grep、`wc -l` |
| 修-26 | §1、§3.4：缓存层 :16、:30-53；「自己监听 sync」 | `PROFILE_KEYS` :16、`loadProfile` :30-48、`GENERATION_KEYS` :69-72、`ctx.translationProfile` :115-131（`onSettingsChanged` :121-124）、`sendTranslationCached` :146-216（内置绕过 :154-156、快照 :162-169、`loadProfile` :173-174、`factors` :179-186） | 行号；`GENERATION_KEYS` 也要去三键 | grep |
| 修-27 | §1、§3.3：`content-auto-translate.js` :487、:790-798 | `effectiveEngine({ auto: true })` :396、`RESTART_KEYS` :708-711（四键在 :711）、监听 :719-720 | 行号 | grep |
| 修-28 | §1、§3.5：`popup.js` :25-29、:452-476、:466；`engine-status.js` :104 | 缺省 :28-32、探测 :497-512、拦截 :552-554；`selectedEngine` :97、`describeEngineStatus` :115、`isApiKeyMissing` :122 | 行号 | grep |
| 修-29 | §1、§4：`batch.js` 失败点 :384、:404-412、:550-558、:576、:615、:494 | :399-408、:411、:432-435/:440/:447、:608-611/:615-617、:628/:631、:668、`MAX_BATCH_FAILURES` :528、`noteBatchFailure` :546-554、`requestBatch` :39 | 行号；:399-408 数量不符转逐条不单独标 | grep |
| 修-30 | §1、§4、§7.3：`content/content-translation.css` :192-238 | 文件已在 `content/css/translation.css`（manifest :193），9 条选择器行号不变 | 路径 | ls |
| 修-31 | §2.3、§2.4：`SyncCollection` 契约未给锚 | `create` :74-77、`assertFits` :156-160、`merge` :166、`mirror` :248、`READY_CAP_MS` :33、`ID_RE` :38；SW 模块模式 `custom-rules-host.js` / `glossary-host.js`、`StorageWriter.create` :52 | 补锚点；固定 id `legacy` 过 `ID_RE` | grep |
| 修-32 | §2.7、§13：规则 v3 只提 B§2.2 | `shared/custom-rules.js` :17-19 版本规矩、`VERSIONS` :37、`validateRule` :142（:155-156 对 v2 的写法、:188 空规则判断）；`ctx.customRules` :311-336 已有 `engineOverride` :79、`domain` :87、`profileSignature` :270、`inherit` | 补 `VERSIONS` 加 3、`profileSignature` 与 `inherit` 带 `profile`、顶层指令加 `profileOverride`（`frames/top.js` :62-63、`child.js` :207） | P1-B/P1-C 合入后的实际形状 |
| 修-33 | §3.2：快照 `{glossary, profile}` | 今天是 `{glossary: snap, addendaSettings}`（缓存层 :169，D-384 F1） | `{glossary, addendaSettings, profile}`；`sendToModel` 加第四个参数 | C§3.3 + D-384 |
| 修-34 | §3.3：设置页引擎一族 `options.html` :911-913 | :934-938；设置页只读 `builtinTranslator`（`options/options-builtin.js` :17） | 行号；补「不发请求」的依据 | grep |
| 修-35 | §3.3：`engineChoices` 唯一调用方是划词卡片 | `content/content-popup.js` :560 | 补锚点 | grep |
| 修-36 | §3.11：「C1 的 `Glossary.validateEntry` 拒绝含分隔符的词条…读这个常量」 | `shared/glossary.js` :119 `validateEntry` 只拒 `TextMarkers.hasMarkers`（:127）；C§11-2 把分隔符那条留给本轮 | 改成「本轮加」 | grep |
| 修-37 | §5：划词 :617、输入框 :266 | 划词 :621（`mode` :624）、对话框 :257（`showResult` :233）；芯片 :274-275 是新入口 | 行号；芯片不流式 | grep |
| 修-38 | §7.3：加载顺序只列文件名 | manifest :113/:131-135/:154/:160-161/:193；`options.html` :919/:934-938/:970；`engine-harness.mjs` :112-130；`helpers.js` :50- | 补锚点与插入位置 | grep |
| 修-39 | §10：引擎文件 830 行「只减不增」；manifest :117-119 | 978 行；manifest :131-135 | 行号；加第 0.5 步预拆与 1k 台账 | `wc -l` |
| 修-40 | §10：新增 D1 第 0 步 | `sources.mjs` :215 `NON_PRODUCT_DIRS`、:221-236 `productSourceFiles()`；消费者三个 | 按 D-390 写入 | 主控裁定 |
| 修-41 | §11：`hover-translation.spec.js` :339 | 未复核该 spec 的行号 | 去掉行号，只留文件名 | 不给未核的锚 |
| 修-42 | §13：接缝只有五条 | R33 #118 已合入：输入框芯片、`ctx.thrownTranslationMessage`（D-384 F4）、语域 `register` | 加 R33 一条 | #118 |

### 自决修（本次修订新增；交主控回填台账编号）

| # | 裁定 | 依据 |
|---|---|---|
| 自决修-A | **解析挂在两个送出口**（`ctx.sendTranslationCached`、`ctx.sendTranslation`），不挂 `ctx.requestTranslation`；`feature` 校验由 `AIProfiles.resolve` 抛 | 修-6：子帧 relay 绕过 `requestTranslation`（`content/frames/top.js` :152-163）；两个送出口是所有请求（含子帧、含内置回落）的必经点 |
| 自决修-B | **`sendToModel` 加第四个位置参数 `profile`**，不改成 opts 对象 | 最小改动：:678 的三参签名与 :822 的调用只各加一个实参；`frozen` 的传法（:686）照旧 |
| 自决修-C | **输入框芯片不流式**，只标 `feature: 'input'` | 芯片经 `ctx.inputWriteback.write`（:174）一次 `insertText` 回写，没有逐段追加的显示面；D-316 定的流式范围是「划词卡片和输入框」，芯片是 R33 之后才有的入口，按最小改动归入不流式 |
| 自决修-D | **`ctx.aiProfiles` 每个帧都建（镜像只问 SW），解析仍只在顶层** | 引擎一族在 `all_frames: true` 的 bundle 里（manifest :207）；`engineChoices`（:831）在子帧也会被划词卡片调用（:560），镜像缺席就抛会让 iframe 里的「换引擎」炸；镜像不依赖顶层，所以子帧能答「配好没有」；D-317「只在顶层帧」改成「解析只在顶层」，C§11-3 的不一致本轮不动 |
| 自决修-E | **`translateBatchWithAI` 留下**（修-12） | :277 的回退 |
| 自决修-F | **「AI 服务」卡片在 D1 就搬进 `options/options-ai-profiles.js`**，不等 D4 | D1 已改 `options.js` 八处读旧键的段落，搬迁与改动同批做才不留一半；925 行的文件再加 D4 的列表会破 1k |
| 自决修-G | **D1 第 0.5 步把引擎 :860-978 搬去 `content/engine/probe.js`** | 978 行，D1 净减不到 20 行，D3 之后必破；`probeStatus` / `builtinTranslator` 是最外层的状态 API，搬它不动请求路径 |
| 自决修-H | **`Glossary.validateEntry` 的分隔符拒绝由本轮加**（修-36） | C§11-2 明写留给收成一处之后 |
| 自决修-I | **`ctx.translationProfile` 的代数订阅加 `ctx.customRules.onProfileChange`** | 规则换档等于换接口地址/模型，缓存要换代；`profileSignature`（:270）带上 `profileOverride()` 后它才会回调 |
| 自决修-J | **流式是 `sendToModel` 内的传输替换**（`opts.onDelta` → 端口），不是第三个解析点 | 缓存查询本来就要先解析出档；端口只在未命中之后打开，`profileId` 沿用 :686 同一处盖上的值，解析点数保持两处（§3.1） |
