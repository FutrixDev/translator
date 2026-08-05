// Guards for shared/api-compat.js — the module that decides which parameters
// each model accepts. These are the rules that break silently when a vendor
// ships a new generation, so they are asserted rather than eyeballed.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The module has no `export` (it is also loaded as a classic script by the
// options page), so importing it for its side effect publishes globalThis.APICompat.
await import('../../shared/api-compat.js');
const A = globalThis.APICompat;

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
const openAIBody = (model, maxTokens = 800, temperature = A.DEFAULT_TEMPERATURE) =>
  A.buildOpenAIRequestBody(model, [{ role: 'user', content: 'hi' }], maxTokens, temperature);

test('reasoning effort matches what each GPT generation accepts', () => {
  // gpt-5.6 dropped 'minimal'; sending it returns HTTP 400. This is the
  // regression that broke gpt-5.6-luna for users.
  for (const model of ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.6']) {
    assert.equal(openAIBody(model).reasoning_effort, 'none', model);
  }
  // Older GPT-5 tiers only know 'minimal'.
  for (const model of ['gpt-5', 'gpt-5-mini', 'gpt-5.4-mini', 'gpt-5.5']) {
    assert.equal(openAIBody(model).reasoning_effort, 'minimal', model);
  }
  // The o-series accepts neither value.
  for (const model of ['o1', 'o3', 'o3-mini', 'o4-mini']) {
    assert.equal('reasoning_effort' in openAIBody(model), false, model);
  }
  // Non-reasoning models get no effort control at all.
  for (const model of ['gpt-4o-mini', 'gpt-4.1-mini', 'deepseek-chat']) {
    assert.equal('reasoning_effort' in openAIBody(model), false, model);
  }
});

test('version comparison is not decimal parsing', () => {
  // parseFloat('5.10') === 5.1 would put a future gpt-5.10 below gpt-5.6.
  assert.equal(openAIBody('gpt-5.10').reasoning_effort, 'none');
});

test('an unreleased major generation lands on the modern parameter shape', () => {
  // Not a prediction about gpt-6's capabilities — just the safer default, since
  // max_tokens is rejected outright by reasoning models.
  const body = openAIBody('gpt-6');
  assert.ok(body.max_completion_tokens > 0);
  assert.equal('max_tokens' in body, false);
  assert.equal('temperature' in body, false);
  assert.equal(body.reasoning_effort, 'none');
});

test('reasoning models use max_completion_tokens and no temperature', () => {
  const body = openAIBody('gpt-5.6-luna');
  assert.equal('max_tokens' in body, false);
  assert.ok(body.max_completion_tokens > 0);
  assert.equal('temperature' in body, false);
});

test('temperature is sent only where the model still honours it', () => {
  assert.equal(openAIBody('gpt-4o-mini').temperature, A.DEFAULT_TEMPERATURE);
  assert.equal(openAIBody('deepseek-chat').temperature, A.DEFAULT_TEMPERATURE);
  assert.equal(openAIBody('gemini-2.5-flash').temperature, A.DEFAULT_TEMPERATURE);
  // Gemini 3+ is tuned for its 1.0 default; lowering it can cause looping.
  assert.equal('temperature' in openAIBody('gemini-3.6-flash'), false);
  assert.equal('temperature' in openAIBody('gemini-3.5-flash-lite'), false);
  // Newer Claude models reject temperature even behind an OpenAI gateway.
  assert.equal('temperature' in openAIBody('claude-opus-5'), false);
});

test('models that bill hidden tokens get a floor on the output budget', () => {
  // A single-word lookup asks for 800; hidden reasoning can consume all of it
  // and return empty text with finish_reason "length".
  for (const model of ['gpt-5.6-luna', 'o3', 'claude-opus-5', 'gemini-3.6-flash']) {
    const budget = A.tokenBudgetFor(model, 800);
    assert.equal(budget, A.REASONING_TOKEN_FLOOR, model);
  }
  // Models without hidden spend keep the caller's budget...
  assert.equal(A.tokenBudgetFor('gpt-4o-mini', 800), 800);
  // ...and the floor never lowers a budget that is already larger.
  assert.equal(A.tokenBudgetFor('gpt-5.6-luna', 8000), 8000);
});

test('gateway-prefixed names are detected like direct ones', () => {
  // The prefix is kept in `model` (the gateway needs it) but must not hide the
  // model's capabilities, so every other field has to match.
  const { model: prefixed, ...viaGateway } = openAIBody('openai/gpt-5.6-luna');
  const { model: direct, ...viaOpenAI } = openAIBody('gpt-5.6-luna');
  assert.equal(prefixed, 'openai/gpt-5.6-luna');
  assert.equal(direct, 'gpt-5.6-luna');
  assert.deepEqual(viaGateway, viaOpenAI);

  assert.equal('temperature' in openAIBody('google/gemini-3.6-flash'), false);
  assert.equal('temperature' in openAIBody('anthropic/claude-opus-5'), false);
});

test('every catalogued model produces a well-formed request', () => {
  for (const [key, provider] of Object.entries(A.PROVIDERS)) {
    for (const model of provider.models) {
      const body = openAIBody(model);
      const label = `${key}/${model}`;
      // Exactly one token-limit field, or the vendor rejects the request.
      assert.equal(
        ('max_tokens' in body) !== ('max_completion_tokens' in body),
        true,
        `${label} must set exactly one token-limit field`
      );
      if ('reasoning_effort' in body) {
        // 'minimal' was removed in gpt-5.6; anything newer must not send it.
        assert.ok(
          ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(body.reasoning_effort),
          `${label} sent an unknown reasoning_effort: ${body.reasoning_effort}`
        );
        assert.equal(
          body.reasoning_effort === 'minimal' && A.versionAtLeast(model, 'gpt', 5, 6),
          false,
          `${label} must not send 'minimal' — gpt-5.6+ rejects it`
        );
      }
    }
  }
});

test('catalog defaults point at a model in their own list', () => {
  for (const [key, provider] of Object.entries(A.PROVIDERS)) {
    if (!provider.defaultModel) continue;
    assert.ok(
      provider.models.includes(provider.defaultModel),
      `${key}.defaultModel "${provider.defaultModel}" is not in ${key}.models`
    );
  }
});

test('catalog lists no retired models', () => {
  // Append here as vendors retire ids, so they cannot be reintroduced.
  const retired = [
    'claude-opus-4-1',      // retires 2026-08-05
    'anthropic/claude-opus-4.1',
    'gemini-2.0-flash',     // shut down 2026-06-01
    'gemini-2.0-flash-lite',
    'gemini-3-flash',       // never reached stable
    'gemini-3-pro',         // 3.x Pro is preview-only
    'google/gemini-3-flash',
    'google/gemini-3-pro'
  ];
  for (const [key, provider] of Object.entries(A.PROVIDERS)) {
    for (const model of provider.models) {
      assert.equal(retired.includes(model), false, `${key} still lists retired model ${model}`);
    }
  }
});

test('no consumer re-declares the shared capability logic', () => {
  // The gpt-5.6 breakage needed fixing in two places because background.js and
  // options.js each carried a copy. Keep it that way: exactly one definition.
  const shared = ['buildOpenAIRequestBody', 'buildClaudeRequestBody', 'tokenBudgetFor',
    'isOpenAIReasoningModel', 'minimalReasoningEffort', 'isClaudeAPI', 'parseAPIError'];
  for (const file of ['background/background.js', 'options/options.js']) {
    const src = repoFile(file);
    for (const name of shared) {
      assert.equal(
        src.includes(`function ${name}(`),
        false,
        `${file} re-declares ${name} — it belongs to shared/api-compat.js alone`
      );
    }
  }
});

test('the options page loads the shared module before its own script', () => {
  const html = repoFile('options/options.html');
  const shared = html.indexOf('shared/api-compat.js');
  const own = html.indexOf('options.js');
  assert.ok(shared !== -1, 'options.html must load shared/api-compat.js');
  assert.ok(shared < own, 'shared/api-compat.js must load before options.js');
});

test('the packaged zip includes the shared module', () => {
  const pkg = JSON.parse(repoFile('package.json'));
  assert.match(pkg.scripts.zip, /\bshared\/\s/, 'npm run zip must package shared/');
});

test('vendor error shapes are all recognised', () => {
  const openai = A.readAPIResponse({ error: { message: 'bad key', code: 401 } }, 401, false, false);
  assert.match(openai.error, /bad key/);
  // Known statuses get an explanation prepended.
  assert.match(openai.error, /API Key/);

  const anthropic = A.readAPIResponse(
    { type: 'error', error: { type: 'invalid_request_error', message: 'bad model' } }, 400, false, true);
  assert.match(anthropic.error, /bad model/);

  const ollama = A.readAPIResponse({ error: 'model not found' }, 404, false, false);
  assert.match(ollama.error, /model not found/);

  // OpenRouter reports some failures with HTTP 200 and an error payload.
  const soft = A.readAPIResponse({ error: { message: 'rate limited' } }, 200, true, false);
  assert.match(soft.error, /rate limited/);

  assert.equal(A.readAPIResponse({ choices: [{ message: { content: ' hi ' } }] }, 200, true, false).text, 'hi');
  assert.equal(A.readAPIResponse({ content: [{ text: ' hi ' }] }, 200, true, true).text, 'hi');
});
