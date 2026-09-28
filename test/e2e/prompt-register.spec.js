// 语域附加说明（R33 A4），落在真页面上：内置表给 reddit 标了 forum、给 arXiv
// 摘要页标了 academic，AI 引擎发出去的系统提示词里就该有对应的那一句 —— 而且
// 只有那一句，不带站点名。
//
// 页面看得见的只有译文，看不见塑造译文的指令；所以断言读的是 mock 记下的系统
// 提示词（test/e2e/mock-openai-server.js 的 systemPrompts）。
//
// 这两站在内置表里都是 `state: 'always'`，走的是自动翻译这条路，和
// page-translation-site-rules.spec.js 一样。引擎是 AI：test/e2e/helpers.js 的
// E2E_BASE_SETTINGS 已经把两张开关都钉在 AI 上，语域也只进 AI 的提示词。
const { test, expect } = require('./fixtures');
const { addGlossaryEntry, setExtensionSettings } = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');

// 给模型的英文句子只写在 shared/prompt-addenda.js 一处；这里读它，不抄一份。
require('../../shared/prompt-addenda.js');
const { REGISTER_SENTENCES, SENTENCES, HEADINGS } = globalThis.PromptAddenda;

const PROMPT_DELIMITER_RE = /segments are separated by "([^"]+)"/;

const RD_TITLE = 'Anyone else think the new borrow checker error messages are lowkey goated';
const RD_BODY = 'Not gonna lie, the compiler roasted me so hard today that I learned three things before lunch.';

const REDDIT_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>thread</title></head>
<body>
  <div id="thing">
    <p class="title" id="title">${RD_TITLE}</p>
    <div class="usertext-body" id="body">${RD_BODY}</div>
  </div>
</body></html>`;

const ABSTRACT = 'We study the convergence of stochastic gradient descent on non-convex objectives under heavy-tailed noise and give matching lower bounds.';

const ARXIV_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>abs</title></head>
<body>
  <div id="abs">
    <blockquote class="abstract" id="abstract">${ABSTRACT}</blockquote>
  </div>
</body></html>`;

function settings(endpoint) {
  return {
    apiEndpoint: endpoint,
    apiKey: 'test-key',
    modelName: 'gpt-4.1-mini',
    targetLang: 'zh-CN',
    skipTargetLanguageText: false,
  };
}

async function serve(context, pattern, html) {
  await context.route(pattern, (route) => {
    route.fulfill({ status: 200, contentType: 'text/html', body: html });
  });
}

test('prompt register: a Reddit thread is translated as forum talk, and the prompt never names the site', async ({ page, context }) => {
  const { close, endpoint, sentTexts, systemPrompts } = await startMockOpenAIServer();

  try {
    await setExtensionSettings(page, settings(endpoint));
    await serve(context, 'https://old.reddit.com/**', REDDIT_PAGE);

    await page.goto('https://old.reddit.com/r/rust/comments/1/goated/');
    await page.waitForSelector('#ai-translator-float-ball');
    await page.waitForSelector('#thing .ai-translator-inline-block', { timeout: 30000 });

    expect(sentTexts.join('\n')).toContain(RD_BODY);
    const pagePrompts = systemPrompts.filter((prompt) => PROMPT_DELIMITER_RE.test(prompt));
    expect(pagePrompts.length).toBeGreaterThan(0);
    for (const prompt of pagePrompts) {
      expect(prompt).toContain(REGISTER_SENTENCES.forum);
      expect(prompt).not.toContain(REGISTER_SENTENCES.academic);
      expect(prompt).not.toMatch(/reddit/i);
    }
  } finally {
    await close();
  }
});

test('prompt register: an arXiv abstract is translated as academic writing, not as forum talk', async ({ page, context }) => {
  const { close, endpoint, sentTexts, systemPrompts } = await startMockOpenAIServer();

  try {
    await setExtensionSettings(page, settings(endpoint));
    await serve(context, 'https://arxiv.org/**', ARXIV_PAGE);

    await page.goto('https://arxiv.org/abs/2401.00001');
    await page.waitForSelector('#ai-translator-float-ball');
    await page.waitForSelector('#abs .ai-translator-inline-block', { timeout: 30000 });

    expect(sentTexts.join('\n')).toContain(ABSTRACT);
    const pagePrompts = systemPrompts.filter((prompt) => PROMPT_DELIMITER_RE.test(prompt));
    expect(pagePrompts.length).toBeGreaterThan(0);
    for (const prompt of pagePrompts) {
      expect(prompt).toContain(REGISTER_SENTENCES.academic);
      expect(prompt).not.toContain(REGISTER_SENTENCES.forum);
      expect(prompt).not.toMatch(/arxiv/i);
    }
  } finally {
    await close();
  }
});

// D-382：同一次请求里语域、领域、词表三样并在一个 addenda 里，一个都不丢，顺序是
// REGISTER、DOMAIN、GLOSSARY。语域来自这一页（reddit 是 forum），领域来自全局设置，
// 词表来自一条词条；compose 覆盖语域的写法会让 REGISTER 行消失。
// [fixture]：领域用 setExtensionSettings 铺、词条走 GLOSSARY_WRITE 消息 —— 两者的
// 真实入口分别由 prompt-domain-context.spec.js（C-J6）和 glossary.spec.js 走过；这
// 一步要证的是三者在一次请求里会合。
test('[fixture] prompt register: a forum page under the legal domain with one glossary entry sends REGISTER, DOMAIN and GLOSSARY together, in order', async ({ page, context, extensionId }) => {
  const { close, endpoint, sentTexts, systemPrompts } = await startMockOpenAIServer();

  try {
    await setExtensionSettings(page, { ...settings(endpoint), promptDomain: 'legal' });
    await addGlossaryEntry(context, extensionId, { s: 'compiler', t: '编译器' });
    await serve(context, 'https://old.reddit.com/**', REDDIT_PAGE);

    await page.goto('https://old.reddit.com/r/rust/comments/1/goated/');
    await page.waitForSelector('#ai-translator-float-ball');
    await page.waitForSelector('#thing .ai-translator-inline-block', { timeout: 30000 });

    expect(sentTexts.join('\n')).toContain(RD_BODY);
    const registerLine = `${HEADINGS.register} ${REGISTER_SENTENCES.forum}`;
    const domainLine = `${HEADINGS.domain} ${SENTENCES.legal}`;
    const glossaryLine = `- ${JSON.stringify('compiler')} → ${JSON.stringify('编译器')}`;
    // 只看带着这条词条的那一批（标题那一段不含 compiler，不带词表）。
    const withGlossary = systemPrompts.filter(
      (prompt) => PROMPT_DELIMITER_RE.test(prompt) && prompt.includes(HEADINGS.glossary));
    expect(withGlossary.length).toBeGreaterThan(0);
    for (const prompt of withGlossary) {
      const lines = prompt.split('\n');
      const at = (line) => lines.indexOf(line);
      expect(at(registerLine), prompt).toBeGreaterThanOrEqual(0);
      expect(at(domainLine), prompt).toBeGreaterThan(at(registerLine));
      expect(at(HEADINGS.glossary), prompt).toBeGreaterThan(at(domainLine));
      expect(at(glossaryLine), prompt).toBe(at(HEADINGS.glossary) + 1);
      expect(prompt).not.toMatch(/reddit/i);
    }
  } finally {
    await close();
  }
});
