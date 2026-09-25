# P0-A 本地模型免 Key + API 错误文案 i18n — 设计

**回合**：P0 功能对标（对标沉浸式翻译），P0-A 为第一个 PR，P1 引擎层在它之上改。
**基线**：origin/main = 8a10465（manifest 1.4.0）。

## 0. 结论

1. 「这份配置要不要 Key」只由 `shared/api-compat.js` 里的一个谓词回答：`APICompat.isApiKeyMissing(settings)`。散落在 SW、内容脚本、popup、设置页的九处 `apiKey` 真值判断全部改用它。单测禁止在 api-compat.js 以外再写裸的 `apiKey` 真值判断。
2. 不需要 Key 的情况：
   - 端点是本机回环：`localhost`、`*.localhost`、`127.0.0.0/8`、`[::1]`；
   - 端点是局域网字面量，按 Chrome Local Network Access 的定义（见 §2.2 的申报决定）；
   - 预设标了 `keyOptional`，即 Ollama 和 LM Studio。
3. Key 为空时，请求不带 `Authorization`（OpenAI 形）或 `x-api-key`（Claude 形），不再发 `Bearer ` 或 `Bearer undefined`。
4. API 失败先在 `api-client` 里变成**结构化失败**（状态码、厂商原文、是否网络失败、端点），再到界面语言已知的那一层**本地化**：SW 的三个 TRANSLATE 处理器和 OCR 用 `uiLanguageOf(settings)`，设置页的「测试连接」用页面语言。十种语言的 `apiError*` 键替换 `ERROR_CODE_MESSAGES` 里写死的中文。
5. 本地模型最常见的两种失败给可操作提示：
   - 403：Ollama 默认拒绝 `chrome-extension://` 来源，要设 `OLLAMA_ORIGINS`；LM Studio 要开 CORS。
   - 连不上：本地服务没启动。
   提示文字以官方文档为准（crawl-store id 768/769/771/772），并在本机实测过（§6.4）。

## 1. 现状（file:line，基线 8a10465）

| 处 | 现在的判断 | 结果 |
|---|---|---|
| `background/background.js:309` `handleTranslate` | `if (!settings.apiKey) return { error: '请先在设置中配置 API Key' }` | 中文写死，本地模型也拦 |
| `background/background.js:328` `handleBatchTranslate` | 同上 | 同上 |
| `background/background.js:346` `handleBatchTranslateFast` | 同上 | 同上 |
| `background/ocr-recognize.js:194` `recognizeWithVision` | `if (!settings.apiKey) throw …configureApiKeyFirst` | 已 i18n，但本地视觉模型也拦 |
| `content/content-translation-engine.js:389–407` `refreshApiKeyPresence` | 只读 `{ apiKey: '' }` | `canFallBackToAI()` 对本地模型永远为假 |
| `content/content-translation-engine.js:480–482` | 只在 `changes.apiKey` 时重算 | 改 provider 或 endpoint 不重算 |
| `shared/engine-status.js:100` | `hasKey = !!(settings && settings.apiKey && …trim())` | popup 和设置页对本地模型显示 `apiNotConfigured` |
| `options/options-connection.js:35` | `if (!apiKey) { showStatus(t('pleaseEnterApiKey')) …}` | 本地模型「测试连接」直接被拦 |
| `popup/popup.js:816` | `… === 'ai' && !settings.apiKey` → `configureApiKeyFirst` + 打开设置页 | 本地模型点「翻译本页」被弹去设置页 |

错误文案：

- `background.js:310/319/328/337/346/355` 六处中文字面量。
- `shared/api-compat.js:229–238` `ERROR_CODE_MESSAGES` 八条中文。
- `shared/api-compat.js:253` 的 `` `API 错误: ${httpStatus}` ``。

请求头：`shared/api-compat.js` 的 `openAIHeaders(apiKey)` / `claudeHeaders(apiKey)` 无条件带 Key 头。

装载：

- api-compat.js 已在 SW（`background.js:2`、`api-client.js` import）和 options.html:829（在 engine-status.js 之前）。
- **没有**装进 popup.html，也**没有**装进 manifest `content_scripts[1]`。

## 2. 唯一谓词

### 2.1 API（全部在 `shared/api-compat.js`，经 `root.APICompat` 公布）

```js
isLocalEndpoint(url)          // → boolean；用 new URL 解析，解析失败为 false；不查 DNS
requiresApiKey(settings)      // → boolean；!(PROVIDERS[provider]?.keyOptional || isLocalEndpoint(apiEndpoint))
isApiKeyMissing(settings)     // → boolean；requiresApiKey(settings) && !String(settings.apiKey || '').trim()
```

- `settings` 只读 `provider`、`apiEndpoint`、`apiKey` 三个键，缺了的按「远端、要 Key」处理：
  - provider 缺省 → 不是 keyOptional；
  - endpoint 缺省或为空 → 不是本地。
- `PROVIDERS.ollama` 和 `PROVIDERS.lmstudio` 加 `keyOptional: true`。其余预设不加。
- 真正发请求的地址是存下来的 `apiEndpoint`：设置页对非 custom 预设写的就是预设端点，见 `options.js` collectSettings。所以端点判定看 `apiEndpoint`，`keyOptional` 看 `provider`。两条是「或」。

### 2.2 申报决定：局域网字面量也免 Key

用户原话列的是回环三种和 keyOptional 预设。本设计把「本地」扩到 Chrome Local Network Access 对 local network 的定义（crawl-store id 773）：

- IPv4：`10/8`、`172.16/12`、`192.168/16`、链路本地 `169.254/16`；
- IPv6：ULA `fc00::/7`、链路本地 `fe80::/10`；
- 映射到上面任一 IPv4 地址的 IPv4-mapped IPv6（`::ffff:a.b.c.d`，`new URL` 会规范成十六进制组，要能认）；
- `.local` 主机名。

理由：

- 「本地模型」的常见形态包括家里另一台机器上的 Ollama，例如 `http://192.168.1.20:11434/...`。它只能走 custom 预设，按回环规则会被迫填一个假 Key。
- 放宽的代价只有一种：局域网网关其实要 Key 而用户没填。那时请求不带认证头，服务端回 401，用户看到本地化的 `apiErrorAuth`，照样能改。
- 这条不涉及隐私：没有 Key 就什么也不会带出去。

**不算本地**：`0.0.0.0`（未指定地址，Chrome 已禁止访问）、公网域名（即使解析到局域网也不算：谓词不查 DNS，与 LNA 的「请求前已知」口径一致）。

### 2.3 替换点（§1 表内九处全部改用谓词）

- SW 三个处理器和 OCR：`APICompat.isApiKeyMissing(settings)`。SW 默认值 `background/settings.js` 加 `provider: 'openai'`，因为现在没有这个键，`chrome.storage.sync.get(defaultSettings)` 拿不到它。
- 内容脚本引擎：`refreshApiKeyPresence` 改读 `{ provider, apiEndpoint, apiKey }`，结果按谓词算。storage.onChanged 在这三个键任一变化时重算。命名随语义改，例如 `aiConfigured`。
- `content/content-auto-translate.js` 的 `RESTART_KEYS` 加 `'provider'`。它已含 `apiKey`、`apiEndpoint`，有单测扫引擎读的键对这张表。
- `shared/engine-status.js:100`：`const ready = !root.APICompat.isApiKeyMissing(settings)`。**懒取** `root.APICompat`，不在模块顶层抓，这样装载顺序出错时报在调用点。
- popup：`popup.js:816` 用谓词。popup 默认值加 `provider: 'openai'` 和 `apiEndpoint: 'https://api.openai.com/v1/chat/completions'`，必须是字面量，与 SW 一致，由 default-settings-agree 单测守。
- 设置页「测试连接」：用表单上的 `{ provider, apiEndpoint, apiKey }` 调 `isApiKeyMissing`，缺 Key 时仍提示 `pleaseEnterApiKey`。
- `background/api-client.js:64–73` `countCharsSentToModel` 的注释引用了旧的 `if (!settings.apiKey)` 闸，随之改写。

## 3. 请求头

`openAIHeaders(apiKey)` / `claudeHeaders(apiKey)`：`String(apiKey || '').trim()` 为空时不设 `Authorization` / `x-api-key`，其余头不变。有 Key 时照旧带，本地端点填了 Key 也照带：LM Studio 开了「Require Authentication」时要它。

## 4. 装载清单

- popup.html：`../shared/api-compat.js` 放在 `../shared/engine-status.js` 之前。
- manifest `content_scripts[1].js`：`shared/api-compat.js` 放在 `shared/engine-status.js` 之前。
  - 该数组归 P1，本 PR 只加这一行，已知会 P1。
  - api-compat.js 是纯函数加预设表的 IIFE，无副作用，内容脚本里多解析约 12 KB。
- options.html 已满足（:829 在 :832 之前）。
- 守护测试：`test/unit/engine-status.test.mjs` 现有「engine-status.js is loaded wherever it is read」「both load lists carry the whole engine family」。扩成「api-compat.js 在三处都排在 engine-status.js 之前」，并对 manifest、popup.html、options.html 各断言一次。

## 5. 错误文案：结构化失败 → 在边界本地化

### 5.1 结构化失败

`APICompat.readAPIResponse(data, httpStatus, ok, isClaudeShape)` 改为返回 `{ text }` 或 `{ failure }`：

```js
failure = {
  status,        // HTTP 状态码；厂商在 200 里塞错误时，取 parseAPIError 的 code（能转成数字就转）
  detail,        // 厂商原文（parseAPIError 的 message），没有就是 ''
}
```

`api-client.js` 的 `callTranslationAPI`（P1 归属，最小改动）：

- fetch reject（连不上、DNS 失败）→ 抛 `Error`，带 `err.apiFailure = { network: true, status: 0, detail: '', endpoint }`；
- `readAPIResponse` 回 `failure` → 抛 `Error`，带 `err.apiFailure = { ...failure, network: false, endpoint }`；
- `err.message` 写成语言中立的技术串，只给日志看，例如 `HTTP 403` / `HTTP 401: <detail>` / `Network error: <endpoint>`。

`formatErrorMessage` 和 `ERROR_CODE_MESSAGES` 删掉，不留兼容层。它们现在的唯一用途就是拼中文。

### 5.2 本地化

```js
APICompat.describeAPIFailure(failure, t, { provider } = {}) // → string
```

`t(key)` 是调用方给的查表函数，api-compat 不依赖 i18n。

判定顺序：

1. `failure.network`：
   - 本地端点 → `apiErrorLocalUnreachable`；
   - 否则 → `apiErrorNetwork`。
   - `{endpoint}` 换成端点的 origin。
2. `status === 403` 且本地端点 → 按服务种类给提示：
   - `provider === 'ollama'` 或端口 11434 → `apiErrorOllamaOrigins`；
   - `provider === 'lmstudio'` 或端口 1234 → `apiErrorLmStudioCors`；
   - 其余 → `apiErrorLocalRefused`（两种都讲）。
3. 已知状态码 → 下面这张表。
4. 其它 → `apiErrorStatus`，`{status}` 换成状态码。

2–4 的结果都在后面接厂商原文：`<说明>\n<detail>`，detail 为空就不接。

| 状态 | key |
|---|---|
| 401 | `apiErrorAuth` |
| 402 | `apiErrorQuota` |
| 403 | `apiErrorForbidden` |
| 404 | `apiErrorModelNotFound` |
| 429 | `apiErrorRateLimited` |
| 500 | `apiErrorServer` |
| 502 | `apiErrorGateway` |
| 503 | `apiErrorUnavailable` |

边界：

- **SW**：background.js 三个处理器和 `ocr-recognize.js` `handleOcrImage` 的 catch 共用**一个** helper，放在新模块或 background.js 内，由实现者定。逻辑：
  - `err.apiFailure` 存在 → `describeAPIFailure(err.apiFailure, key => getMessage(key, uiLanguageOf(settings)), settings)`；
  - 否则 → `err.message || getMessage('translationFailed', lang)`。
  - 缺 Key 用已有的 `configureApiKeyFirst`。
- **设置页**：`options-connection.js` 用同一个 `describeAPIFailure`。
  - `t` 用页面自己的；
  - fetch reject 构造 `{ network: true, endpoint }`；
  - 显示格式保持 `` `${t('connectionFailed')}: ${描述}` ``。

内容脚本不改：它显示的是 SW 回来的 `response.error` 字符串，已经是界面语言。

### 5.3 新键（十种语言，按功能成块，锚在 `configureApiKeyFirst` 之后）

`apiErrorAuth`、`apiErrorQuota`、`apiErrorForbidden`、`apiErrorModelNotFound`、`apiErrorRateLimited`、`apiErrorServer`、`apiErrorGateway`、`apiErrorUnavailable`、`apiErrorStatus`（`{status}`）、`apiErrorNetwork`（`{endpoint}`）、`apiErrorLocalUnreachable`（`{endpoint}`）、`apiErrorOllamaOrigins`、`apiErrorLmStudioCors`、`apiErrorLocalRefused`。

占位符沿用仓库惯例 `t(key).replace('{site}', …)`，`getMessage` 本身不带参数。

英文底稿（实现者可润色，但事实不能改）：

- `apiErrorOllamaOrigins`：Ollama refused the request (HTTP 403). By default it only accepts browser extensions listed in OLLAMA_ORIGINS — set OLLAMA_ORIGINS=chrome-extension://* and restart Ollama.
- `apiErrorLmStudioCors`：LM Studio refused the request (HTTP 403). Turn on CORS in LM Studio's server settings, or start the server with: lms server start --cors
- `apiErrorLocalRefused`：The local model server refused the request (HTTP 403). Ollama: set OLLAMA_ORIGINS=chrome-extension://* and restart it. LM Studio: turn on CORS in its server settings.
- `apiErrorLocalUnreachable`：Can't reach {endpoint}. Make sure the local model server is running — Ollama: ollama serve; LM Studio: start the server in the Developer tab, or run lms server start.
- `apiErrorNetwork`：Can't reach {endpoint}. Check your network connection and the API endpoint.

**不能写**的说法：

- 「CORS 导致连不上」：扩展 SW 带 host permission 时不受 CORS 约束（crawl-store id 770）。Ollama 的拒绝是服务端按 Origin 回 403，不是浏览器拦。
- LNA 权限提示：官方博客没说扩展 SW 受不受它约束（id 773），不下结论。

### 5.4 `_locales` 的边界（申报决定）

`_locales/*/messages.json` 只放 manifest 和 `chrome.i18n` 真正消费的串，目前是 `appName`、`appDescription`、`cmdTogglePage`。本回合的新文案全是运行时 `getMessage`/`t()` 读的，只进 `i18n/lang/*`。两边重复存一份只会让它们漂移。brief 说「两套文件都要补」，本项按「用到哪套补哪套」执行：P0-A 没有新的 manifest 字符串，所以不动 `_locales`。

## 6. 依据

### 6.1 官方文档（crawl-store）

| id | 来源 | 用到的事实 |
|---|---|---|
| 768 | Ollama FAQ | 默认只放行 127.0.0.1/0.0.0.0 来源；浏览器扩展要把 `chrome-extension://*` 加进 `OLLAMA_ORIGINS`；macOS `launchctl setenv`、Linux systemd `Environment=`、Windows 环境变量，改完重启 |
| 769 | LM Studio `lms server start` | `--cors` 开 CORS（默认关）、`--port` |
| 771 | LM Studio server settings | 「Enable CORS」开关；「Require Authentication」可要求 API token |
| 772 | LM Studio OpenAI 兼容 | base URL `http://localhost:1234/v1` |
| 770 | Chrome network requests | 扩展 SW 和带 host permission 的扩展页面不受 CORS 约束，内容脚本受 |
| 773 | Chrome LNA 博客 | local network / loopback 的地址定义 |

### 6.2 本机实测（2026-09-24，Ollama 0.20.0，未设 OLLAMA_ORIGINS）

- `GET /api/version` 不带 Origin → 200。
- 带 `Origin: chrome-extension://…` → **403**。
- `POST /v1/chat/completions` 带扩展 Origin → **403，空 body**（len=0）。所以 `response.json()` 失败、`detail` 为空，提示必须只靠状态码和「本地端点」两条就给得出。

## 7. 测试

### 7.1 单测（建议新文件 `test/unit/api-key-rule.test.mjs`）

- **谓词真值表**：
  - 回环：`localhost`、`foo.localhost`、`127.0.0.1`、`127.9.9.9`、`[::1]`；
  - 局域网：`10.0.0.2`、`172.16.0.1`、`172.31.255.255`、`192.168.1.20`、`169.254.1.1`、`[fd00::1]`、`[fe80::1]`、`[::ffff:192.168.1.2]`、`mybox.local`；
  - **非**本地：`172.32.0.1`、`8.8.8.8`、`0.0.0.0`、`api.openai.com`、`localhost.evil.com`、`127.0.0.1.nip.io`、空串、非 URL；
  - `keyOptional` 预设加远端端点；
  - `provider` 缺省。
- **禁止裸真值判断**：扫 background/、content/、shared/、popup/、options/、pdf/、offscreen/ 下全部 `.js`，除 `shared/api-compat.js` 外，不得出现对 `apiKey` 值的真值判断。
  - 要抓的形如：`!settings.apiKey`、`!apiKey`、`!!(… apiKey …)`、`apiKey &&`、`apiKey ?`、`if (apiKey)`。
  - 允许：取值、赋值、作参数传递、存取 storage。
  - 附变异自检：把上述每种写法各喂一次正则，断言都会命中。
- **请求头**：Key 为空、为空白、为 `undefined` 时，两种头都不含认证字段；有 Key 时含。
- **`describeAPIFailure`**：
  - 每个状态码键；
  - 403 本地三分支（provider 与端口两种判法）；
  - 403 远端走 `apiErrorForbidden`；
  - 网络本地与远端两种；
  - detail 接在后面；
  - `t` 缺键时不抛。
- **CJK 字面量扫描**：`background/background.js`、`background/api-client.js`、`background/ai-translate.js`、`background/ocr-recognize.js`、`shared/api-compat.js`、`options/options-connection.js`、`popup/popup.js` 的**代码字面量**不得含中日韩字符。注释不算。
  - `background/settings.js` 的 `languageNames` 留给 P0-B，不在扫描内。
- **i18n**：新键十种语言齐全，由现有 `i18n-locale-coverage` 守，另断言英文底稿含 `OLLAMA_ORIGINS`、`chrome-extension://*` 和 `--cors`。
- **现有测试随前提改**：
  - `api-compat.test.mjs` 里断言 401 串含 `/API Key/` 的那条，改成断言 `failure` 结构 + `describeAPIFailure` 的输出；
  - `engine-status.test.mjs` 的「only the AI engine is judged by the API key」加本地端点、keyOptional 的正反例，并 import api-compat。

### 7.2 e2e 旅程（验收单元）

mock 扩展（`test/e2e/mock-openai-server.js`，不许 spec 自起 http 服务）：

- 记录每次请求的 `authorization` 与 `x-api-key` 头；
- 新增选项 `status`（或 `respondWith`），整台 mock 以给定状态码加空 body 作答，用来模拟 Ollama 的 403。
- 「连不上」用起一台 mock、记下端口、`close()` 后再指过去。

| 旅程 | 前提 | 用户动作 → 可见结果 | 断言 |
|---|---|---|---|
| J-A1 划词免 Key | `translationEngine:'ai'`，`provider:'custom'`，`apiEndpoint`=127.0.0.1 mock，`apiKey:''` | 在页面选中文本 → 触发划词翻译 → 卡片出 `[T] …` 译文 | 卡片可见、在视口内；mock 收到请求且**无** Authorization 头 |
| J-A2 整页免 Key | 同上 | 触发整页翻译 → 段落下出现译文 | 译文节点数 > 0；mock 全部请求无 Authorization 头 |
| J-A3 远端缺 Key 本地化 | `provider:'openai'`，默认端点，`apiKey:''`，`uiLanguage:'ja'` | 选词翻译 | 卡片文字 === `getMessage('configureApiKeyFirst','ja')`；mock 未收到任何请求 |
| J-A4 本地 403 提示 | mock 以 403 空 body 作答，端点 127.0.0.1（custom），`uiLanguage:'en'` | 选词翻译 | 卡片含 `apiErrorLocalRefused` 的英文全文 |
| J-A5 本地连不上提示 | 端点指向已关闭的 127.0.0.1 端口 | 选词翻译 | 卡片含 `apiErrorLocalUnreachable`，`{endpoint}` 已替换 |
| J-A6 popup 与设置页 | 本地端点、`apiKey:''`、`translationEngine:'ai'` | 打开 popup；在设置页选 Ollama 或 custom 本地端点点「测试连接」 | popup 状态不是 `apiNotConfigured`；测试连接对 mock 成功 |

现有 e2e 的前提复核：

- `feature-settings.spec.js` 的「test connection … reports the missing field」用 `provider:'openai'`，远端，照旧要 Key，不变。
- `popup-status.spec.js` 的 `{ translationEngine:'ai', apiKey:'' }` 靠默认端点，是远端，照旧 `apiNotConfigured`，不变。
- 其余 spec 都带 `apiKey:'test-key'`，照旧带头。

凡是因前提改变而改动的 spec，都要在交付报告里逐条申报。

### 7.3 真机补证（主控验收时做）

另起一个 Ollama 实例（例如 `OLLAMA_HOST=127.0.0.1:11435 OLLAMA_ORIGINS='chrome-extension://*' ollama serve`），不改用户常驻的 11434。把扩展指过去、不填 Key，确认真出译文；再把端点改回 11434（未设 ORIGINS），确认卡片出 `apiErrorOllamaOrigins`。

## 8. 文档

- **README**（英文与中文两段）：
  - API 配置表写明「本地模型（Ollama / LM Studio / 局域网端点）可以不填 Key」；
  - Ollama 与 LM Studio 两行补上 `OLLAMA_ORIGINS` 和 LM Studio 开 CORS 的做法，出处同 §6.1；
  - 逐条对照真实 DOM 和写入函数写，不写不存在的按钮。
- **CHANGELOG**：顶部新建 `## Unreleased`，本项写自己的小节。
- **隐私政策**：不改。出网面没变：请求照旧只发往用户自己配置的端点，只是少带一个空的认证头。

## 9. 不做 / 与 P1 的交界

- 不碰 `ai-translate.js` 的八处 `settings.apiKey` 传参，那是 P1 的多配置引擎层。
- `api-client.js` 只做 §5.1 的结构化失败。
- manifest `content_scripts` 只加一行 api-compat.js。
- 不做「多配置」「流式」「重试」，这些归 P1。
- 不改 `languageNames`，归 P0-B。

## 10. 决策登记

D-288 起，写在 `translator-g/docs/delivery/decisions.md`：

- 谓词位置与定义，含局域网放宽；
- api-compat 进 popup 与 content_scripts；
- 空 Key 不带认证头；
- 结构化失败加边界本地化，删 `ERROR_CODE_MESSAGES`；
- `_locales` 边界；
- 2026-09-19 综合报告里「不做引导向导」「popup 四行不加开关」两条立场由本回合 P0-F / P0-C 取代。
