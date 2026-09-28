// Blab Translation background — how one model request is shaped.
//
// 供应商之间的形状差异（请求体、请求头、怎么读回答）一律在 shared/api-compat.js。
// 这里只把一个 AI 配置档加一次请求（system、user、maxTokens、temperature）拼成
// { endpoint, claudeShape, headers, body }；真正发出去、超时和取消在
// background/model-client.js 的 callModel。设置页的「测试连接」（AI_PROFILE_TEST）
// 走的也是 callModel，所以那里测通的就是这里拼得出来的。

import '../shared/api-compat.js';
import '../shared/storage-writer.js';
import '../shared/auto-stats.js';

// Every provider/model shape decision lives in shared/api-compat.js so the
// options page's connection test exercises the identical request.
const {
  isClaudeAPI,
  openAIHeaders,
  claudeHeaders,
  buildOpenAIRequestBody,
  buildClaudeRequestBody
} = globalThis.APICompat;

/**
 * The request for one call to this profile's model. `system` may be empty
 * (the connection test sends none); `temperature` is only read by the OpenAI
 * shape, and even there api-compat drops it for models that reject it.
 */
function modelRequest(profile, { system, user, maxTokens, temperature }) {
  const endpoint = profile.apiEndpoint;
  if (isClaudeAPI(endpoint)) {
    return {
      endpoint,
      claudeShape: true,
      headers: claudeHeaders(profile.apiKey),
      body: buildClaudeRequestBody(profile.modelName, user, maxTokens, system)
    };
  }
  const messages = system
    ? [{ role: 'system', content: system }, { role: 'user', content: user }]
    : [{ role: 'user', content: user }];
  return {
    endpoint,
    claudeShape: false,
    headers: openAIHeaders(profile.apiKey),
    body: buildOpenAIRequestBody(profile.modelName, messages, maxTokens, temperature)
  };
}

// A thrown error carries `apiFailure` ({ network, status, detail, endpoint },
// or { timeout, seconds } / { empty }), which the handler turns into the
// reader's language with APICompat.describeAPIFailure. Its `message` is a
// language-neutral technical string for logs only.
function apiError(message, apiFailure) {
  const error = new Error(message);
  error.apiFailure = apiFailure;
  return error;
}

// 本机统计里「发给模型的字符数」记在每一次**真的要发出去**的调用上，而不是记在
// 消息监听器里。
//
// 监听器看着像那条路上唯一的收口，其实不是，两头都漏：
//   - 漏在前面：两个 handler 都以缺 Key 的那一关开头（`APICompat.isApiKeyMissing`
//     —— 远端端点没填 Key 时直接回错，本地模型不需要 Key，照常放行）。被拦下的
//     请求一个字符也不会离开浏览器。而自动翻译一页最多同时开 12 批、失败的块下一
//     轮还会再来，于是在监听器里记账，被拦的人每打开一页，就有整整一页的字符被记
//     进「发给模型」，而浏览器一个字节都没往外送。
//   - 漏在后面：一条消息不一定只对应一次调用。快速分批的分隔符数量对不上时会**
//     整批重发一次**（走编号法，见 translateBatchFastWithAI 末尾），按消息记账就
//     会少算掉那一整批。
//
// 记在 ai-translate.js 的三个函数上就没有这两个口子：两个在自己的 handler 里、
// 缺 Key 那一关之后被调用，编号法只在快速分批的回退里被调用一次 —— 一次调用一
// 笔账，不多不少。
//
// 数的是源文本的字符数，不是请求体。发出去之后才失败的（网络错误、限流、500）
// 照记：那些字符确实送出去了。
function countCharsSentToModel(chars) {
  if (chars > 0) globalThis.AutoStats.add({ aiChars: chars });
}

export { isClaudeAPI, modelRequest, apiError, countCharsSentToModel };
