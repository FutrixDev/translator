// Blab Translation background — the HTTP half of an AI translation request.
//
// 供应商之间的形状差异（请求体、请求头、怎么读回答）一律在 shared/api-compat.js，
// 设置页的「测试连接」走的是同一份，所以那里测通的就是这里发得出去的。

import '../shared/api-compat.js';
import '../shared/auto-stats.js';

// Every provider/model shape decision lives in shared/api-compat.js so the
// options page's connection test exercises the identical request.
const {
  isClaudeAPI,
  openAIHeaders,
  claudeHeaders,
  buildOpenAIRequestBody,
  buildClaudeRequestBody,
  readAPIResponse
} = globalThis.APICompat;

// Issue one translation request and return its text, or throw with a
// user-facing message. Both vendors are handled the same way: some APIs report
// failures with HTTP 200 and an error payload, so the body is always parsed.
async function callTranslationAPI(endpoint, headers, body, isClaudeShape) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => ({}));
  const result = readAPIResponse(data, response.status, response.ok, isClaudeShape);
  if (result.error) throw new Error(result.error);
  return result.text;
}

// Call Claude API with Anthropic-specific format
async function callClaudeAPI(endpoint, apiKey, model, systemPrompt, userContent, maxTokens = 4096) {
  return callTranslationAPI(
    endpoint,
    claudeHeaders(apiKey),
    buildClaudeRequestBody(model, userContent, maxTokens, systemPrompt),
    true
  );
}

// Call OpenAI-compatible API
async function callOpenAIAPI(endpoint, apiKey, model, systemPrompt, userContent, maxTokens = 4096, temperature = globalThis.APICompat.DEFAULT_TEMPERATURE) {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent }
  ];
  return callTranslationAPI(
    endpoint,
    openAIHeaders(apiKey),
    buildOpenAIRequestBody(model, messages, maxTokens, temperature),
    false
  );
}

// 本机统计里「发给模型的字符数」记在每一次**真的要发出去**的调用上，而不是记在
// 消息监听器里。
//
// 监听器看着像那条路上唯一的收口，其实不是，两头都漏：
//   - 漏在前面：三个 handler 都以 `if (!settings.apiKey) return { error }` 开头，
//     没配 Key 时一个字符也不会离开浏览器。而自动翻译一页最多同时开 12 批、失败
//     的块下一轮还会再来，于是没配 Key 的人每打开一页，就有整整一页的字符被记进
//     「发给模型」，而浏览器一个字节都没往外送。
//   - 漏在后面：一条消息不一定只对应一次调用。快速分批的分隔符数量对不上时会**
//     整批重发一次**（走编号法，见 translateBatchFastWithAI 末尾），按消息记账就
//     会少算掉那一整批。
//
// 记在这三个函数上就没有这两个口子：它们各自只有一个外部调用点（就是自己的
// handler，在 apiKey 那一关之后），加上回退那一次内部调用 —— 一次调用一笔账，不
// 多不少。
//
// 数的是源文本的字符数，不是请求体。发出去之后才失败的（网络错误、限流、500）
// 照记：那些字符确实送出去了。
function countCharsSentToModel(chars) {
  if (chars > 0) globalThis.AutoStats.add({ aiChars: chars });
}

export { isClaudeAPI, callTranslationAPI, callClaudeAPI, callOpenAIAPI, countCharsSentToModel };
