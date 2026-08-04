// Provider API compatibility: the single place that knows how each vendor's
// endpoint is shaped and which parameters a given model accepts.
//
// MAINTENANCE CONTRACT
// When a provider ships a new model generation, this file should be the only
// one that needs editing. It is loaded by both the service worker (which does
// the real translating) and the options page (whose "test connection" button
// must exercise the exact same request shape — otherwise the probe can pass
// while translation fails, which is how the gpt-5.6 breakage reached users).
//
// Model lineups last verified 2026-08-04 against:
//   OpenAI    https://developers.openai.com/api/docs/guides/latest-model
//   Anthropic https://platform.claude.com/docs/en/about-claude/models/overview
//   Google    https://ai.google.dev/gemini-api/docs/models
//
// Loaded as a classic script by the options page and as a side-effect import by
// the module service worker, so it publishes onto the global object rather than
// using `export`.
(function (root) {
  'use strict';

  // --- Model capability detection ------------------------------------------

  // Strip provider prefixes ("openai/gpt-5.6-luna" -> "gpt-5.6-luna") so
  // gateway-routed names are detected the same as direct ones.
  function normalizeModelName(model) {
    const name = String(model || '').toLowerCase().trim();
    return name.includes('/') ? name.split('/').pop() : name;
  }

  // Compare the version embedded in a model name ("gpt-5.6-luna" -> 5.6).
  // Major and minor are compared separately so a future "gpt-5.10" sorts above
  // "gpt-5.6" instead of being read as the decimal 5.1.
  function versionAtLeast(model, family, major, minor) {
    const match = normalizeModelName(model).match(new RegExp(`^${family}-(\\d+)(?:\\.(\\d+))?`));
    if (!match) return false;
    const gotMajor = parseInt(match[1], 10);
    const gotMinor = match[2] ? parseInt(match[2], 10) : 0;
    return gotMajor > major || (gotMajor === major && gotMinor >= (minor || 0));
  }

  // GPT-5.x and o-series reasoning models renamed `max_tokens` to
  // `max_completion_tokens` and only accept the default temperature (an
  // explicit temperature returns HTTP 400).
  //
  // The whole GPT-5 line reasons, so anything at gpt-5 or above is assumed to
  // as well — an unreleased gpt-6 then lands on the modern parameter shape
  // instead of the legacy one. That is the safer guess in both directions:
  // `max_completion_tokens` is the current field name and works for newer
  // non-reasoning models too, whereas `max_tokens` is rejected outright by
  // reasoning models. Re-verify when a new major generation actually ships.
  function isOpenAIReasoningModel(model) {
    return versionAtLeast(model, 'gpt', 5) || /^o[1-9]/.test(normalizeModelName(model));
  }

  // Lowest `reasoning_effort` the model accepts, or null when it has no such
  // control. Translation never needs chain-of-thought, so we always ask for the
  // floor — but the name of that floor changed across generations:
  //   gpt-5 … gpt-5.5  -> 'minimal'
  //   gpt-5.6+         -> 'minimal' was dropped; the floor is now 'none'
  // Sending 'minimal' to gpt-5.6-{sol,terra,luna} fails with HTTP 400
  // ("Unsupported value: 'reasoning_effort' does not support 'minimal'").
  // The o-series never accepted either value, so it gets nothing.
  function minimalReasoningEffort(model) {
    if (!versionAtLeast(model, 'gpt', 5)) return null;
    return versionAtLeast(model, 'gpt', 5, 6) ? 'none' : 'minimal';
  }

  // Gemini 3+ is tuned around its default temperature (1.0). Google's guidance
  // is to leave temperature unset: lowering it — standard practice on older
  // models — can push these models into loops or degrade quality on harder
  // input. Gemini 3 also cannot switch thinking off.
  function isGemini3OrNewer(model) {
    return versionAtLeast(model, 'gemini', 3);
  }

  // Newer Claude models reject `temperature`/`top_p` ("deprecated for this
  // model"), including when reached through an OpenAI-compatible gateway. The
  // native Claude path never sends temperature, so mirror that for any Claude
  // model however it is reached.
  function isClaudeModelName(model) {
    return /claude|opus|sonnet|haiku|fable|mythos/.test(normalizeModelName(model));
  }

  // Reasoning (GPT-5/o-series), modern thinking (Claude) and Gemini 3+ models
  // spend part of the output budget on hidden reasoning/thinking tokens. A
  // short call such as a single-word lookup (budget 800) can be consumed
  // entirely by that hidden spend, returning empty text with finish_reason
  // "length". Give these models a floor so the visible translation always has
  // room. The token limit is only a cap, so raising it never lengthens a
  // normal translation.
  const REASONING_TOKEN_FLOOR = 2000;

  function spendsHiddenTokens(model) {
    return isOpenAIReasoningModel(model) || isClaudeModelName(model) || isGemini3OrNewer(model);
  }

  function tokenBudgetFor(model, maxTokens) {
    return spendsHiddenTokens(model) ? Math.max(maxTokens, REASONING_TOKEN_FLOOR) : maxTokens;
  }

  // --- Endpoint detection ---------------------------------------------------

  // Anthropic's native Messages API, as opposed to anything speaking the
  // OpenAI Chat Completions shape (including Claude behind a gateway).
  function isClaudeAPI(endpoint) {
    if (!endpoint) return false;
    return endpoint.includes('anthropic.com') || endpoint.includes('/v1/messages');
  }

  const CLAUDE_API_VERSION = '2023-06-01';

  function openAIHeaders(apiKey) {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    };
  }

  function claudeHeaders(apiKey) {
    return {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': CLAUDE_API_VERSION
    };
  }

  // --- Request bodies -------------------------------------------------------

  // Translation wants stable, literal output, so it asks for a low temperature
  // wherever the model still honours one. Shared so the connection test probes
  // with the same value translation will use.
  const DEFAULT_TEMPERATURE = 0.3;

  // Build an OpenAI-compatible request body with model-aware parameters.
  function buildOpenAIRequestBody(model, messages, maxTokens, temperature) {
    const body = { model, messages };
    const tokenLimit = tokenBudgetFor(model, maxTokens);

    if (isOpenAIReasoningModel(model)) {
      // GPT-5.x / o-series: new token-limit field, default temperature only.
      body.max_completion_tokens = tokenLimit;
      // Skip heavy chain-of-thought for translation, using whichever spelling
      // of the floor this generation accepts.
      const effort = minimalReasoningEffort(model);
      if (effort) body.reasoning_effort = effort;
    } else {
      body.max_tokens = tokenLimit;
      if (typeof temperature === 'number' && !isClaudeModelName(model) && !isGemini3OrNewer(model)) {
        body.temperature = temperature;
      }
    }

    return body;
  }

  // Build a native Anthropic Messages body. `systemPrompt` is optional: the
  // connection probe sends none.
  function buildClaudeRequestBody(model, userContent, maxTokens, systemPrompt) {
    const body = {
      model,
      max_tokens: tokenBudgetFor(model, maxTokens),
      messages: [{ role: 'user', content: userContent }]
    };
    if (systemPrompt) body.system = systemPrompt;
    return body;
  }

  // --- Responses ------------------------------------------------------------

  // Parse a vendor error out of a response body. Vendors disagree on the shape,
  // and some return HTTP 200 with an error payload (OpenRouter does this).
  function parseAPIError(data, httpStatus) {
    if (data && data.error) {
      const error = data.error;
      // OpenAI/OpenRouter: {"error": {"message": "...", "code": ...}}
      if (typeof error === 'object') {
        return {
          isError: true,
          message: error.message || error.msg || JSON.stringify(error),
          code: error.code || error.type || httpStatus
        };
      }
      // Ollama and friends: {"error": "..."}
      if (typeof error === 'string') {
        return { isError: true, message: error, code: httpStatus };
      }
    }

    // Anthropic: {"type": "error", "error": {...}}
    if (data && data.type === 'error' && data.error) {
      return {
        isError: true,
        message: data.error.message || JSON.stringify(data.error),
        code: data.error.type || httpStatus
      };
    }

    return { isError: false };
  }

  // Turn a parsed error into the string shown to the user. Errors that carry a
  // familiar HTTP status get an explanation prepended, because vendor messages
  // for these are often opaque.
  const ERROR_CODE_MESSAGES = {
    401: '认证失败：请检查 API Key 是否正确',
    402: '额度不足：请检查账户余额或升级套餐',
    403: '访问被拒绝：API Key 可能没有权限',
    404: '模型不存在：请检查模型名称是否正确',
    429: '请求过于频繁：请稍后重试',
    500: '服务器错误：API 服务暂时不可用',
    502: '网关错误：API 服务暂时不可用',
    503: '服务不可用：API 服务暂时不可用'
  };

  function formatErrorMessage(message, code) {
    const explanation = ERROR_CODE_MESSAGES[parseInt(code, 10)];
    return explanation ? `${explanation}\n${message}` : message;
  }

  // Read one response body and return either its text or a thrown-ready error
  // message. Returns { text } on success, { error } otherwise.
  function readAPIResponse(data, httpStatus, ok, isClaudeShape) {
    const errorInfo = parseAPIError(data, httpStatus);
    if (errorInfo.isError) {
      return { error: formatErrorMessage(errorInfo.message, errorInfo.code) };
    }
    if (!ok) {
      return { error: `API 错误: ${httpStatus}` };
    }
    const text = isClaudeShape
      // Claude: { content: [{ type: "text", text: "..." }] }
      ? (data && data.content && data.content[0] && data.content[0].text)
      // OpenAI: { choices: [{ message: { content: "..." } }] }
      : (data && data.choices && data.choices[0] && data.choices[0].message
        && data.choices[0].message.content);
    return { text: (text || '').trim() };
  }

  // --- Provider catalog -----------------------------------------------------

  const PROVIDERS = {
    openai: {
      name: 'OpenAI',
      endpoint: 'https://api.openai.com/v1/chat/completions',
      // gpt-5.6 ships as three tiers (sol > terra > luna); the bare "gpt-5.6"
      // alias routes to sol. Luna is the high-volume tier, so it leads.
      models: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4o', 'gpt-4o-mini', 'o3', 'o3-mini', 'o4-mini'],
      defaultModel: 'gpt-4.1-mini'
    },
    anthropic: {
      name: 'Anthropic Claude',
      endpoint: 'https://api.anthropic.com/v1/messages',
      // Native Anthropic API accepts version aliases (no date suffix); aliases
      // avoid stale/incorrect dates. claude-opus-4-1 is omitted: it retires
      // 2026-08-05.
      models: ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-haiku-4-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-opus-4-5', 'claude-sonnet-4-5'],
      defaultModel: 'claude-sonnet-5'
    },
    gemini: {
      name: 'Google Gemini',
      endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      // Stable text models only: gemini-3-pro/gemini-3-flash never reached
      // stable (3.x Pro is preview-only) and the 2.0 line shut down
      // 2026-06-01.
      models: ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
      defaultModel: 'gemini-3.6-flash'
    },
    deepseek: {
      name: 'DeepSeek',
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      models: ['deepseek-chat', 'deepseek-reasoner'],
      defaultModel: 'deepseek-chat'
    },
    openrouter: {
      name: 'OpenRouter',
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      // OpenRouter spells versions with dots where the native APIs use dashes
      // (anthropic/claude-opus-4.8 vs claude-opus-4-8).
      models: [
        // Anthropic Claude
        'anthropic/claude-opus-5',
        'anthropic/claude-sonnet-5',
        'anthropic/claude-opus-4.8',
        'anthropic/claude-opus-4.5',
        'anthropic/claude-sonnet-4.5',
        'anthropic/claude-haiku-4.5',
        'anthropic/claude-sonnet-4',
        'anthropic/claude-opus-4',
        // OpenAI
        'openai/gpt-5.6-luna',
        'openai/gpt-5.6-terra',
        'openai/gpt-5.6-sol',
        'openai/gpt-5.5',
        'openai/gpt-5',
        'openai/gpt-5-mini',
        'openai/gpt-4.1',
        'openai/gpt-4.1-mini',
        'openai/gpt-4.1-nano',
        'openai/gpt-4o',
        'openai/gpt-4o-mini',
        'openai/o3',
        'openai/o3-mini',
        'openai/o4-mini',
        // Google Gemini
        'google/gemini-3.6-flash',
        'google/gemini-3.5-flash',
        'google/gemini-3.5-flash-lite',
        'google/gemini-2.5-pro',
        'google/gemini-2.5-flash',
        // DeepSeek
        'deepseek/deepseek-chat',
        'deepseek/deepseek-reasoner'
      ],
      defaultModel: 'anthropic/claude-sonnet-5'
    },
    ollama: {
      name: 'Ollama (Local)',
      endpoint: 'http://localhost:11434/v1/chat/completions',
      models: ['llama3.3', 'qwen2.5', 'deepseek-r1', 'gemma2'],
      defaultModel: 'llama3.3'
    },
    lmstudio: {
      name: 'LM Studio (Local)',
      endpoint: 'http://localhost:1234/v1/chat/completions',
      models: [],
      defaultModel: ''
    },
    custom: {
      name: 'Custom',
      endpoint: '',
      models: [],
      defaultModel: ''
    }
  };

  root.APICompat = {
    normalizeModelName,
    versionAtLeast,
    isOpenAIReasoningModel,
    minimalReasoningEffort,
    isGemini3OrNewer,
    isClaudeModelName,
    spendsHiddenTokens,
    REASONING_TOKEN_FLOOR,
    tokenBudgetFor,
    DEFAULT_TEMPERATURE,
    isClaudeAPI,
    CLAUDE_API_VERSION,
    openAIHeaders,
    claudeHeaders,
    buildOpenAIRequestBody,
    buildClaudeRequestBody,
    parseAPIError,
    formatErrorMessage,
    readAPIResponse,
    PROVIDERS
  };
})(globalThis);
