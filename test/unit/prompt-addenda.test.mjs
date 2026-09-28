// 语域附加说明（R33 A4）：内置站点表给一页定体裁，内容脚本只把标签挂上消息，
// 服务工作者把关后拼进系统提示词。
//
// 契约：
//   - shared/prompt-addenda.js 的 validate() 只收 `{register?, glossary?, domain?,
//     context?}`（缺了也抛），register 是 REGISTERS 之一；多一个字段（比如 host）就抛。
//   - SiteRules.register(host, path) 只读内置表，没有就是 null。
//   - buildPrompt 的顺序：模板 → 附加说明块 → 公式占位符规则 → extraRules。
//   - background/ai-translate.js 的每一条路（单句、单词、编号批、快速批、快速批
//     回退编号批，各自的默认模板与自定义提示词两支）发出去的系统提示词都带那一句。
//   - 三个处理函数先 validate 再翻译。
//
// shared/prompt-addenda.js 与 background/prompts.js 的 composePromptAddenda：
// 附加说明（词表、领域、页面上下文）随 AI 请求去，形状在 SW 入口把关，拼成系统
// 提示词里模板之后、数学规则之前的一块。
//
// 钉住四件事（设计 §6.3 那一行）：
//   - 超限和多余字段都抛，不截断；缺了 addenda 也抛（内容脚本一律盖，R33）；
//   - general 领域不发句子；
//   - 块排在数学规则之前，三个 buildPrompt 分支（含单词翻译）都带；
//   - 块里不会出现 mock 服务器 PROMPT_DELIMITER_RE 认的那句话 —— 用户写的原文
//     即使就是那句话，经 JSON.stringify 后引号前多了反斜杠，匹配不上。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { workerSource } from './helpers/sources.mjs';

// ---- 服务工作者那一半在 Node 里要的最少环境 -------------------------------
// ai-translate.js 经 settings.js / api-client.js 摸到 chrome 与 fetch；这里给
// 能加载的最小桩，fetch 记下每一次请求体。
const requests = [];
let reply = () => 'translated';
globalThis.chrome = {
  storage: {
    local: { get: async () => ({}), set: async () => {} },
    sync: { get: async (defaults) => defaults || {}, set: async () => {} },
    onChanged: { addListener() {} },
  },
  runtime: { id: 'test', getManifest: () => ({ version: '0' }), sendMessage: async () => ({}) },
  i18n: { getUILanguage: () => 'en' },
};
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  requests.push(body);
  const content = reply(body.messages[0].content, body.messages[1].content);
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
console.warn = () => {};

await import('../../shared/site-rules-builtin.js');
await import('../../shared/storage-writer.js');
await import('../../shared/lang-tags.js');
await import('../../shared/site-rules.js');
const prompts = await import('../../background/prompts.js');
const ai = await import('../../background/ai-translate.js');

const { PromptAddenda, SiteRules, SiteRulesBuiltin } = globalThis;
const FORUM = { register: 'forum' };
const FORUM_LINE = `${PromptAddenda.HEADINGS.register} ${PromptAddenda.REGISTER_SENTENCES.forum}`;
const SETTINGS = {
  apiEndpoint: 'https://api.openai.com/v1/chat/completions',
  apiKey: 'test-key',
  modelName: 'gpt-4.1-mini',
  customPrompt: '',
};
const CUSTOM = { ...SETTINGS, customPrompt: 'Translate into {targetLang}. Be brief.' };

function systemPrompts() {
  return requests.map((body) => body.messages[0].content);
}

// ---- validate / stamp ------------------------------------------------------

test('validate accepts an empty addenda and every register', () => {
  PromptAddenda.validate({});
  for (const register of PromptAddenda.REGISTERS) PromptAddenda.validate({ register });
});

test('validate refuses anything else, including a label that also carries the host', () => {
  const bad = [
    // 内容脚本一律盖（没有语域是 `{}`），缺了这个字段也是缺陷（R33 D-360 F8）。
    undefined,
    null, [], 'forum', 7, Object.create(null),
    { register: 'forum', host: 'reddit.com' },
    { domain: 'forum' },
    { register: 'casual' },
    { register: '' },
    { register: null },
  ];
  for (const addenda of bad) {
    assert.throws(() => PromptAddenda.validate(addenda), /PromptAddenda: invalid addenda/,
      `accepted ${JSON.stringify(addenda)}`);
  }
});

test('stamp is the register label, or an empty string when there is none', () => {
  assert.equal(PromptAddenda.stamp(undefined), '');
  assert.equal(PromptAddenda.stamp({}), '');
  for (const register of PromptAddenda.REGISTERS) {
    assert.equal(PromptAddenda.stamp({ register }), register);
  }
});

test('every register has its own English sentence, and no sentence names a site', () => {
  const sentences = PromptAddenda.REGISTERS.map((r) => PromptAddenda.REGISTER_SENTENCES[r]);
  assert.equal(new Set(sentences).size, PromptAddenda.REGISTERS.length);
  // 规则的 match 是 `host/path` 模式（或一组）；取主机名顶级域前的那一段
  // （reddit、arxiv、ycombinator…）。
  const names = SiteRulesBuiltin.rules
    .flatMap((rule) => [].concat(rule.match))
    .map((pattern) => pattern.split('/')[0].split('.').slice(-2)[0])
    .filter((name) => name.length > 3);
  assert.ok(names.includes('reddit') && names.includes('arxiv'), names.join(','));
  for (const sentence of sentences) {
    assert.ok(sentence && !/[一-鿿]/.test(sentence), sentence);
    assert.doesNotMatch(sentence, /\.(com|org|net|io|uk)\b/i);
    for (const name of names) {
      assert.ok(!sentence.toLowerCase().includes(name), `${name} in: ${sentence}`);
    }
  }
});

// ---- 内置表与读法 ----------------------------------------------------------

test('SiteRules.register reads the built-in table by host and path', () => {
  const cases = [
    ['x.com', '/home', 'social'],
    ['twitter.com', '/someone/status/1', 'social'],
    ['old.reddit.com', '/r/test/', 'forum'],
    ['www.reddit.com', '/r/test/comments/1/x/', 'forum'],
    ['news.ycombinator.com', '/item', 'forum'],
    ['arxiv.org', '/abs/2401.00001', 'academic'],
    ['arxiv.org', '/pdf/2401.00001', null],
    ['www.bbc.co.uk', '/news/articles/x', 'news'],
    ['www.nytimes.com', '/2026/01/01/x.html', 'news'],
    ['medium.com', '/@a/b', null],
    ['www.youtube.com', '/watch', null],
    ['example.com', '/', null],
  ];
  for (const [host, path, expected] of cases) {
    assert.equal(SiteRules.register(host, path), expected, `${host}${path}`);
  }
});

test('a built-in rule whose register is not a non-empty string makes the table malformed', () => {
  // 形状在 site-rules.js 的 validRule 里查；取值（是不是 REGISTERS 之一）由下一条
  // 对照，服务工作者收到时再 validate 一遍。
  const reddit = SiteRulesBuiltin.rules.find((rule) => rule.match === 'reddit.com');
  for (const register of [7, '', null, ['forum']]) {
    const table = SiteRules.loadTable({ ...SiteRulesBuiltin, rules: [{ ...reddit, register }] });
    assert.equal(table.ok, false, `register ${JSON.stringify(register)} passed`);
  }
  assert.equal(SiteRules.loadTable({ ...SiteRulesBuiltin, rules: [reddit] }).ok, true);
});

test('every register in the built-in table is one the prompt knows', () => {
  const used = SiteRulesBuiltin.rules.filter((rule) => rule.register !== undefined);
  assert.ok(used.length > 20, `only ${used.length} rules carry a register`);
  for (const rule of used) {
    assert.ok(PromptAddenda.REGISTERS.includes(rule.register), JSON.stringify(rule));
  }
});

// ---- 提示词 ----------------------------------------------------------------

test('composePromptAddenda writes one headed line per register and nothing for none', () => {
  assert.equal(prompts.composePromptAddenda(undefined), '');
  assert.equal(prompts.composePromptAddenda({}), '');
  const lines = PromptAddenda.REGISTERS.map((register) => prompts.composePromptAddenda({ register }));
  assert.equal(new Set(lines).size, lines.length);
  assert.equal(prompts.composePromptAddenda(FORUM), FORUM_LINE);
});

test('buildPrompt puts the addenda after the template and before the math rule and extra rules', () => {
  const plain = prompts.buildPrompt('TEMPLATE {targetLang}', 'Chinese', {}, '', { addenda: FORUM });
  assert.equal(plain, `TEMPLATE Chinese\n\n${FORUM_LINE}${prompts.MATH_PLACEHOLDER_RULE}`);

  const extra = prompts.buildPrompt('TEMPLATE', 'Chinese', {}, 'EXTRA', { addenda: FORUM });
  assert.equal(extra, `TEMPLATE\n\n${FORUM_LINE}${prompts.MATH_PLACEHOLDER_RULE}\n\nEXTRA`);

  const word = prompts.buildPrompt('TEMPLATE', 'Chinese', {}, 'EXTRA', { includeMathRule: false, addenda: FORUM });
  assert.equal(word, `TEMPLATE\n\n${FORUM_LINE}\n\nEXTRA`);

  const none = prompts.buildPrompt('TEMPLATE', 'Chinese', {}, '', {});
  assert.equal(none, `TEMPLATE${prompts.MATH_PLACEHOLDER_RULE}`);
});

test('the fast batch prompt still announces its delimiter with an addendum on it', () => {
  // test/e2e/mock-openai-server.js 靠这句找分隔符；附加说明拼在模板之后，不能挡着它。
  const PROMPT_DELIMITER_RE = /segments are separated by "([^"]+)"/;
  for (const [template, extra] of [
    [prompts.FAST_BATCH_PROMPT, ''],
    ['Custom {targetLang}', prompts.getFastBatchOutputRules('@@')],
  ]) {
    const built = prompts.buildPrompt(template, 'Chinese', { delimiter: '@@' }, extra, { addenda: FORUM });
    assert.equal(built.match(PROMPT_DELIMITER_RE)?.[1], '@@');
    assert.ok(built.includes(FORUM_LINE));
  }
});

test('the register rule is in every text template and text rule set, and in no word one', () => {
  // 单词/词典那一路没有语域可守（R33 N4），只在文字路径上。
  for (const [name, text] of Object.entries({
    SINGLE_WORD_PROMPT: prompts.SINGLE_WORD_PROMPT,
    WORD_OUTPUT_RULES: prompts.WORD_OUTPUT_RULES,
  })) {
    assert.ok(!text.includes(prompts.REGISTER_RULE), `${name} carries the register rule`);
  }
  const texts = {
    DEFAULT_PROMPT: prompts.DEFAULT_PROMPT,
    DEFAULT_BATCH_PROMPT: prompts.DEFAULT_BATCH_PROMPT,
    BATCH_OUTPUT_RULES: prompts.BATCH_OUTPUT_RULES,
    FAST_BATCH_PROMPT: prompts.FAST_BATCH_PROMPT,
    getFastBatchOutputRules: prompts.getFastBatchOutputRules('@@'),
  };
  for (const [name, text] of Object.entries(texts)) {
    assert.ok(text.includes(prompts.REGISTER_RULE), `${name} lacks the register rule`);
  }
  // 自定义提示词那一支在变量替换之后才拼规则，规则里出现 {x} 就是一个不会被替换的洞。
  assert.doesNotMatch(prompts.REGISTER_RULE, /[{}]/);
});

// ---- 每条请求路径都把附加说明送到模型 --------------------------------------

async function sentWith(run) {
  requests.length = 0;
  await run();
  return systemPrompts();
}

for (const [label, settings] of [['default template', SETTINGS], ['custom prompt', CUSTOM]]) {
  test(`every AI path carries the addendum (${label})`, async () => {
    reply = () => 'translated';
    const single = await sentWith(() => ai.translateTextWithMode(
      'A sentence long enough not to count as one word.', 'zh-CN', settings, false, FORUM));
    const word = await sentWith(() => ai.translateTextWithMode('hello', 'zh-CN', settings, true, FORUM));

    reply = () => '[1] A\n\n[2] B';
    const numbered = await sentWith(() => ai.translateBatchWithAI(['a', 'b'], 'zh-CN', settings, FORUM));

    reply = () => 'A@@B';
    const fast = await sentWith(() => ai.translateBatchFastWithAI(['a', 'b'], 'zh-CN', settings, '@@', FORUM));

    for (const [path, sent] of Object.entries({ single, word, numbered, fast })) {
      assert.equal(sent.length, 1, `${path}: ${sent.length} requests`);
      assert.ok(sent[0].includes(FORUM_LINE), `${path} lost the addendum:\n${sent[0]}`);
    }
  });

  test(`the fast batch's numbered fallback carries the addendum too (${label})`, async () => {
    // 快速批段数对不上就改发编号批 —— 第二个请求也得带着这一页的体裁。
    reply = (system) => (/segments are separated/.test(system) ? 'only one segment' : '[1] A\n\n[2] B');
    const sent = await sentWith(() => ai.translateBatchFastWithAI(['a', 'b'], 'zh-CN', settings, '@@', FORUM));
    assert.equal(sent.length, 2, 'the fallback did not happen');
    assert.doesNotMatch(sent[1], /segments are separated/);
    assert.ok(sent[1].includes(FORUM_LINE), `the fallback lost the addendum:\n${sent[1]}`);
  });
}

test('with empty addenda the system prompt carries no register line at all', async () => {
  reply = () => 'translated';
  const sent = await sentWith(() => ai.translateTextWithMode(
    'A sentence long enough not to count as one word.', 'zh-CN', SETTINGS, false, {}));
  assert.doesNotMatch(sent[0], new RegExp(PromptAddenda.HEADINGS.register));
});

test('a custom prompt of only whitespace is no custom prompt, on every path (R33 D-360 F5)', async () => {
  // 以前单句那一路只看真值：'   ' 当成自定义提示词，系统提示词就只剩空白加规则，
  // 而三条批量/单词路看 trim()，用的是默认模板。
  const BLANK = { ...SETTINGS, customPrompt: ' \n\t ' };
  const paths = {
    single: [() => 'translated', (settings) => ai.translateTextWithMode(
      'A sentence long enough not to count as one word.', 'zh-CN', settings, false, {})],
    word: [() => 'translated', (settings) => ai.translateTextWithMode('hello', 'zh-CN', settings, true, {})],
    numbered: [() => '[1] A\n\n[2] B', (settings) => ai.translateBatchWithAI(['a', 'b'], 'zh-CN', settings, {})],
    fast: [() => 'A@@B', (settings) => ai.translateBatchFastWithAI(['a', 'b'], 'zh-CN', settings, '@@', {})],
  };
  for (const [path, [answer, run]] of Object.entries(paths)) {
    reply = answer;
    const blank = await sentWith(() => run(BLANK));
    const plain = await sentWith(() => run(SETTINGS));
    assert.equal(blank.length, 1, path);
    assert.equal(blank[0], plain[0], `${path}: a blank custom prompt replaced the default template`);
  }
});

// ---- 服务工作者的三个处理函数：先把关，再翻译 ------------------------------

test('each TRANSLATE handler validates the addenda before it translates, and the switch hands them over', () => {
  const src = workerSource();
  const handlers = {
    handleTranslate: 'translateTextWithMode(',
    handleBatchTranslate: 'translateBatchWithAI(',
    handleBatchTranslateFast: 'translateBatchFastWithAI(',
  };
  for (const [name, call] of Object.entries(handlers)) {
    const start = src.indexOf(`async function ${name}(`);
    assert.ok(start >= 0, `${name} not found`);
    const body = src.slice(start, src.indexOf('\n}\n', start));
    const validated = body.indexOf('PromptAddenda.validate(addenda)');
    const translated = body.indexOf(call);
    assert.ok(validated >= 0, `${name} does not validate the addenda`);
    assert.ok(translated > validated, `${name} translates before validating`);
    assert.match(body.slice(translated), /addenda\)/, `${name} does not pass the addenda on`);
    assert.match(src, new RegExp(`${name}\\([^)]*message\\.addenda\\)`), `the switch drops addenda for ${name}`);
  }
});

// ---- 词表、领域、页面上下文（P1-C）----------------------------------------

const {
  MATH_PLACEHOLDER_RULE,
  SINGLE_WORD_PROMPT,
  WORD_OUTPUT_RULES,
  DEFAULT_PROMPT,
  FAST_BATCH_PROMPT,
  getFastBatchOutputRules,
  composePromptAddenda,
  buildPrompt,
} = prompts;

// mock 服务器里那条正则，从源码取，不抄一份（抄的会和它走散）。
const MOCK_SOURCE = readFileSync(
  fileURLToPath(new URL('../e2e/mock-openai-server.js', import.meta.url)), 'utf8');
const PROMPT_DELIMITER_RE = (() => {
  const literal = /const PROMPT_DELIMITER_RE = \/(.+)\/;/.exec(MOCK_SOURCE);
  assert.ok(literal, 'mock-openai-server.js still declares PROMPT_DELIMITER_RE');
  return new RegExp(literal[1]);
})();

const DELIMITER = '⟪⟫⟪⟫⟪⟫';

test('validate: {} and an empty glossary are shape-valid', () => {
  // undefined 不再合法：内容脚本一律盖 addenda，缺了是缺陷（上面语域那一节的
  // validate 用例钉住它抛）。
  assert.doesNotThrow(() => PromptAddenda.validate({}));
  assert.doesNotThrow(() => PromptAddenda.validate({ glossary: [] }));
  assert.doesNotThrow(() => PromptAddenda.validate({
    glossary: [{ s: 'attention', t: '注意力' }, { s: 'Transformer' }],
    domain: 'tech',
    context: { title: 't', before: '', after: 'a' },
  }));
});

test('validate: every limit is exact — at the limit passes, one over throws', () => {
  const { LIMITS } = PromptAddenda;
  const many = (n) => Array.from({ length: n }, (_, i) => ({ s: `term${i}` }));
  assert.doesNotThrow(() => PromptAddenda.validate({ glossary: many(LIMITS.entries) }));
  assert.throws(() => PromptAddenda.validate({ glossary: many(LIMITS.entries + 1) }), /glossary entries/);

  assert.doesNotThrow(() => PromptAddenda.validate({ glossary: [{ s: 'x'.repeat(LIMITS.source) }] }));
  assert.throws(() => PromptAddenda.validate({ glossary: [{ s: 'x'.repeat(LIMITS.source + 1) }] }), /glossary source/);
  assert.doesNotThrow(() => PromptAddenda.validate({ glossary: [{ s: 'x', t: 'y'.repeat(LIMITS.target) }] }));
  assert.throws(() => PromptAddenda.validate({ glossary: [{ s: 'x', t: 'y'.repeat(LIMITS.target + 1) }] }), /glossary target/);

  for (const field of ['title', 'before', 'after']) {
    assert.doesNotThrow(() => PromptAddenda.validate({ context: { [field]: 'c'.repeat(LIMITS[field]) } }));
    assert.throws(() => PromptAddenda.validate({ context: { [field]: 'c'.repeat(LIMITS[field] + 1) } }),
      new RegExp(`context ${field}`));
  }
});

test('validate: extra fields and wrong types throw; the message carries no user text', () => {
  const secret = 'PRIVATE-TERM';
  const cases = [
    { glossary: [{ s: secret, t: 'x', extra: 1 }] },
    { glossary: [{ s: secret }], extra: true },
    { context: { title: secret, url: 'https://x' } },
    { glossary: [{ s: '' }] },
    { glossary: [{ s: 1 }] },
    { glossary: [{ s: secret, t: null }] },
    { glossary: { s: secret } },
    { domain: 'poetry' },
    { context: 'plain' },
    null,
    [],
    'addenda',
  ];
  for (const addenda of cases) {
    assert.throws(() => PromptAddenda.validate(addenda), (error) => {
      assert.match(error.message, /^PromptAddenda: invalid addenda/);
      assert.ok(!error.message.includes(secret), 'no user text in the error message');
      return true;
    }, JSON.stringify(addenda));
  }
});

test('DOMAINS: nine ids, every one has an English sentence, general has none', () => {
  assert.deepEqual([...PromptAddenda.DOMAINS],
    ['general', 'tech', 'academic', 'legal', 'medical', 'finance', 'gaming', 'fiction', 'news']);
  for (const id of PromptAddenda.DOMAINS) {
    if (id === 'general') continue;
    assert.ok(PromptAddenda.SENTENCES[id].length > 0, id);
    assert.doesNotMatch(PromptAddenda.SENTENCES[id], /[^\x20-\x7e]/, `${id} is plain English`);
  }
  assert.equal(composePromptAddenda({ domain: 'general' }), '');
  assert.equal(composePromptAddenda({ domain: 'legal' }), `DOMAIN: ${PromptAddenda.SENTENCES.legal}`);
});

test('composePromptAddenda: the block of the design, strings through JSON.stringify', () => {
  const block = composePromptAddenda({
    glossary: [{ s: 'Transformer' }, { s: 'attention', t: '注意力' }],
    domain: 'tech',
    context: { title: 'On "Attention"', before: 'line1\nline2', after: '' },
  });
  assert.equal(block, [
    `DOMAIN: ${PromptAddenda.SENTENCES.tech}`,
    'GLOSSARY (user-defined; overrides any general rule about keeping terms in their original form):',
    '- "Transformer" → keep as written',
    '- "attention" → "注意力"',
    'PAGE CONTEXT (reference only; do not translate it and do not include it in the output):',
    '{"title":"On \\"Attention\\"","before":"line1\\nline2"}',
  ].join('\n'));
  // 空的附加说明拼出空串，buildPrompt 的输出与没有附加说明时逐字相同。
  for (const empty of [undefined, {}, { glossary: [] }, { domain: 'general' }, { context: {} }]) {
    assert.equal(composePromptAddenda(empty), '');
    assert.equal(buildPrompt(DEFAULT_PROMPT, 'Chinese', {}, '', { addenda: empty }),
      buildPrompt(DEFAULT_PROMPT, 'Chinese'));
  }
});

test('composePromptAddenda: REGISTER, DOMAIN, GLOSSARY, PAGE CONTEXT, in that order (D-382)', () => {
  const block = composePromptAddenda({
    register: 'forum',
    domain: 'legal',
    glossary: [{ s: 'tort', t: '侵权' }],
    context: { title: 'A thread' },
  });
  assert.equal(block, [
    `${PromptAddenda.HEADINGS.register} ${PromptAddenda.REGISTER_SENTENCES.forum}`,
    `DOMAIN: ${PromptAddenda.SENTENCES.legal}`,
    'GLOSSARY (user-defined; overrides any general rule about keeping terms in their original form):',
    '- "tort" → "侵权"',
    'PAGE CONTEXT (reference only; do not translate it and do not include it in the output):',
    '{"title":"A thread"}',
  ].join('\n'));
});

test('composePromptAddenda: a register and a domain with the same id send the DOMAIN line only (D-382)', () => {
  const shared = PromptAddenda.REGISTERS.filter((id) => PromptAddenda.DOMAINS.includes(id));
  assert.deepEqual(shared, ['news', 'academic'], 'the ids both lists carry');
  for (const id of shared) {
    assert.equal(composePromptAddenda({ register: id, domain: id }), `DOMAIN: ${PromptAddenda.SENTENCES[id]}`, id);
  }
  // 不同的 id 两行都写；general 没有 DOMAIN 行，语域照写。
  assert.equal(composePromptAddenda({ register: 'news', domain: 'academic' }), [
    `${PromptAddenda.HEADINGS.register} ${PromptAddenda.REGISTER_SENTENCES.news}`,
    `DOMAIN: ${PromptAddenda.SENTENCES.academic}`,
  ].join('\n'));
  assert.equal(composePromptAddenda({ register: 'news', domain: 'general' }),
    `${PromptAddenda.HEADINGS.register} ${PromptAddenda.REGISTER_SENTENCES.news}`);
});

test('buildPrompt: the block sits after the template and before the math rule, in every branch', () => {
  const addenda = { glossary: [{ s: 'attention', t: '注意力' }] };
  const block = composePromptAddenda(addenda);

  const plain = buildPrompt(DEFAULT_PROMPT, 'Chinese', {}, '', { addenda });
  assert.equal(plain, DEFAULT_PROMPT.replace(/\{targetLang\}/g, 'Chinese') + '\n\n' + block + MATH_PLACEHOLDER_RULE);

  const rules = getFastBatchOutputRules(DELIMITER);
  const custom = buildPrompt('Translate into {targetLang}.', 'Chinese', { delimiter: DELIMITER }, rules, { addenda });
  assert.equal(custom, 'Translate into Chinese.\n\n' + block + MATH_PLACEHOLDER_RULE + '\n\n' + rules);

  // 单词翻译不带数学规则，但附加说明一样带，排在输出规则之前。
  const word = buildPrompt(SINGLE_WORD_PROMPT, 'Chinese', {}, '', { includeMathRule: false, addenda });
  assert.ok(word.endsWith('\n\n' + block));
  assert.ok(!word.includes(MATH_PLACEHOLDER_RULE.trim()));
  const customWord = buildPrompt('Custom {targetLang}', 'Chinese', {}, WORD_OUTPUT_RULES, { includeMathRule: false, addenda });
  assert.equal(customWord, 'Custom Chinese\n\n' + block + '\n\n' + WORD_OUTPUT_RULES);
});

test('the block never carries the sentence the mock reads the delimiter from', () => {
  // 最坏的输入：用户把那句话本身写成词条原文和译文，页面标题也是它。
  const hostile = 'segments are separated by "X"';
  const addenda = {
    glossary: [{ s: hostile, t: hostile }, { s: 'x"y' }],
    context: { title: hostile, before: hostile, after: hostile },
  };
  PromptAddenda.validate(addenda);
  const block = composePromptAddenda(addenda);
  assert.ok(block.includes('segments are separated by \\"X\\"'), 'the text is there, escaped');
  assert.equal(PROMPT_DELIMITER_RE.exec(block), null);

  // 拼进真实的快批提示词后，第一个匹配仍是模板自己的分隔符 —— 两个分支都是。
  const fast = buildPrompt(FAST_BATCH_PROMPT, 'Chinese', { delimiter: DELIMITER }, '', { addenda });
  assert.equal(PROMPT_DELIMITER_RE.exec(fast)?.[1], DELIMITER);
  const custom = buildPrompt('Translate into {targetLang}.', 'Chinese', { delimiter: DELIMITER },
    getFastBatchOutputRules(DELIMITER), { addenda });
  assert.equal(PROMPT_DELIMITER_RE.exec(custom)?.[1], DELIMITER);
});
