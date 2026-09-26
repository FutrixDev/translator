// 站点适配的第一批规则，落在真页面上。
//
// 收集器的通则是**从形状猜**：有块级可翻子元素就下探，没有就整块翻。对文章型
// 页面这套够用，对社交时间线不够——
//
//   - 一条推文的正文是 `<div data-testid="tweetText">` 里一串 `<span>`，没有任何
//     块级子元素，猜不出「这一串是一句话」；按通则每个 `<span>` 各自是一个内联
//     可翻元素，于是一条推文被切成一句一请求，译文一句一句插回去。
//   - 作者名、时间戳、票数、"reply" 在形状上和正文没有区别，通则挡不住，翻出来
//     只是把时间线塞满没人看的译文——还是按块付的钱。
//
// 内置表（shared/site-rules-builtin.js）对这两件事各写了一串选择器，
// content/page/site-adapter.js 把它们解析出来，collect.js 照着走。这条 spec 检验
// 的就是「照着走」：原子块整块翻，排除块一个字都不送。
//
// 用的是自动翻译这条路——内置表里这几站都是 `state: 'always'`，页面一落地就该
// 自己翻。手动触发反而会和自动翻译抢同一页（一个在翻，一个把译文收起来）。
const { test, expect } = require('./fixtures');
const { setExtensionSettings } = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');

const TWEET_A = 'The paper shows a clean separation between the two halves of the pipeline.';
const TWEET_B = 'Every number in table three was reproduced from scratch, with no tuning at all.';
const AUTHOR = 'Alice Researcher';
const STAMP = 'September the nineteenth';

const X_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>X</title></head>
<body>
  <article id="tweet">
    <div data-testid="User-Name"><a href="/alice" id="author">${AUTHOR}</a></div>
    <time id="stamp" datetime="2026-09-19">${STAMP}</time>
    <div data-testid="tweetText" id="tweet-text"><span>${TWEET_A}</span><span> ${TWEET_B}</span></div>
    <div role="group" id="actions"><span>Reply to this post</span><span>Repost this post</span></div>
  </article>
</body></html>`;

const HN_STORY = 'A small compiler that fits in a single file and still passes the whole suite';
const HN_SUBTEXT = 'points by someone eleven hours ago with forty two comments';

const HN_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Hacker News</title></head>
<body>
  <table><tbody>
    <tr class="athing"><td class="rank">1.</td><td class="title"><span id="story">${HN_STORY}</span></td></tr>
    <tr><td class="subtext"><span id="sub">${HN_SUBTEXT}</span></td></tr>
  </tbody></table>
</body></html>`;

const ABSTRACT = 'We describe a decoder that keeps the two halves of a long document aligned without supervision.';
const AUTHORS = 'Alice Researcher, Bob Engineer and Carol Scientist';
const HISTORY = 'Submitted on the nineteenth of September, revised twice since then';

const ARXIV_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>arXiv</title></head>
<body>
  <div id="abs">
    <blockquote class="abstract" id="abstract"><span class="descriptor">Abstract:</span> ${ABSTRACT}</blockquote>
    <div class="authors" id="authors">${AUTHORS}</div>
    <div class="submission-history" id="history">${HISTORY}</div>
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

test('site rules: a tweet is translated as one block, and its chrome is not translated at all', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();

  try {
    await setExtensionSettings(page, settings(endpoint));
    await serve(context, 'https://x.com/**', X_PAGE);

    await page.goto('https://x.com/alice/status/1');
    await page.waitForSelector('#ai-translator-float-ball');
    await page.waitForSelector('#tweet .ai-translator-inline-block', { timeout: 30000 });

    // 一条推文一个译文块。没有原子块规则时这里是两个（一个 <span> 一个）。
    await expect(page.locator('#tweet .ai-translator-inline-block')).toHaveCount(1);

    // 而且两句话是**在同一次请求里**去的：原子块的意义就在这里，不是「碰巧也只
    // 插了一个块」。
    const oneRequestWithBoth = sentTexts.some((text) => text.includes(TWEET_A) && text.includes(TWEET_B));
    expect(oneRequestWithBoth).toBe(true);

    // 作者名、时间戳、操作栏：一个字都没送出去。
    const all = sentTexts.join('\n');
    expect(all).not.toContain(AUTHOR);
    expect(all).not.toContain(STAMP);
    expect(all).not.toContain('Repost this post');
    await expect(page.locator('#author .ai-translator-inline-block')).toHaveCount(0);
    await expect(page.locator('#actions .ai-translator-inline-block')).toHaveCount(0);
  } finally {
    await close();
  }
});

test('site rules: a Hacker News subtext line is skipped while the story title is translated', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();

  try {
    await setExtensionSettings(page, settings(endpoint));
    await serve(context, 'https://news.ycombinator.com/**', HN_PAGE);

    await page.goto('https://news.ycombinator.com/');
    await page.waitForSelector('#ai-translator-float-ball');
    // 译文块落在 <td class="title"> 里还是它后面由插入层决定，这条断言不管那个：
    // 只要页面上出现了译文，这一轮收集就已经跑完，下面两句才有话可说。
    await page.waitForSelector('.ai-translator-inline-block', { timeout: 30000 });

    const all = sentTexts.join('\n');
    expect(all).toContain(HN_STORY);
    expect(all).not.toContain(HN_SUBTEXT);
    await expect(page.locator('.subtext .ai-translator-inline-block')).toHaveCount(0);
  } finally {
    await close();
  }
});

test('site rules: an arXiv abstract is translated whole, its author and history lines are not', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();

  try {
    await setExtensionSettings(page, settings(endpoint));
    await serve(context, 'https://arxiv.org/**', ARXIV_PAGE);

    await page.goto('https://arxiv.org/abs/2401.00001');
    await page.waitForSelector('#ai-translator-float-ball');
    await page.waitForSelector('#abs .ai-translator-inline-block', { timeout: 30000 });

    const all = sentTexts.join('\n');
    expect(all).toContain(ABSTRACT);
    expect(all).not.toContain(AUTHORS);
    expect(all).not.toContain(HISTORY);
    await expect(page.locator('#authors .ai-translator-inline-block')).toHaveCount(0);
    await expect(page.locator('#history .ai-translator-inline-block')).toHaveCount(0);
  } finally {
    await close();
  }
});

const LTX_PROSE = 'The decoder keeps a single buffer alive across the whole document instead of allocating one per span.';
const LTX_AUTHORS = 'Dana Author, Erik Coauthor — work performed while visiting another lab';
const LTX_BIB = 'Alice Researcher and Bob Engineer. A study of long documents. In Proceedings of Somewhere, 2019.';

// 全文的 HTML 版是 LaTeXML 出的，class 全是 ltx_ 开头，和摘要页一个 class 都不共用。
// 这一页的 host 故意写成 ar5iv.labs.arxiv.org：内置表里只有 `arxiv.org/html/*` 一条，
// 它靠 hostMatches 的后缀匹配顺带管住 ar5iv，这条旅程就是那句话的凭据。
const LTX_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>ar5iv</title></head>
<body>
  <div class="ltx_page_content" id="doc">
    <div class="ltx_authors" id="ltx-authors"><span class="ltx_personname">${LTX_AUTHORS}</span></div>
    <div class="ltx_para" id="para"><p class="ltx_p">${LTX_PROSE}</p></div>
    <ul class="ltx_bibliography" id="bib"><li class="ltx_bibitem">${LTX_BIB}</li></ul>
  </div>
</body></html>`;

test('site rules: an arXiv HTML paper is translated on ar5iv too, minus its authors and bibliography', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();

  try {
    await setExtensionSettings(page, settings(endpoint));
    await serve(context, 'https://ar5iv.labs.arxiv.org/**', LTX_PAGE);

    await page.goto('https://ar5iv.labs.arxiv.org/html/1706.03762');
    await page.waitForSelector('#ai-translator-float-ball');
    await page.waitForSelector('#para .ai-translator-inline-block', { timeout: 30000 });

    const all = sentTexts.join('\n');
    expect(all).toContain(LTX_PROSE);
    // 参考文献是全文里最贵的一块，翻成中文之后读者反而搜不到原文了；作者名同理。
    // 两块都有直属文本，没有规则时通用启发式会照翻。
    expect(all).not.toContain(LTX_BIB);
    expect(all).not.toContain(LTX_AUTHORS);
    await expect(page.locator('#bib .ai-translator-inline-block')).toHaveCount(0);
    await expect(page.locator('#ltx-authors .ai-translator-inline-block')).toHaveCount(0);
  } finally {
    await close();
  }
});

const RD_TITLE = 'Someone rewrote the whole parser in a single afternoon and it came out faster';
const RD_BODY = 'The trick was to stop allocating a fresh node for every token and reuse one buffer instead.';
const RD_SCORE = 'four hundred and twelve points';
const RD_TAGLINE = 'submitted by a very prolific poster who has been here since two thousand and nine';
const RD_AGO = 'about twelve hours ago';

// 内置表里写的是 `reddit.com`，这一页的 host 是 `old.reddit.com`——
// SiteRules.hostMatches 的 `h.endsWith('.' + p)` 那一支，顺带也测了子域继承。
const REDDIT_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>reddit</title></head>
<body>
  <div id="thing">
    <p class="title" id="title">${RD_TITLE}</p>
    <div class="score" id="score">${RD_SCORE}</div>
    <p class="tagline" id="tagline">${RD_TAGLINE}</p>
    <faceplate-timeago id="ago">${RD_AGO}</faceplate-timeago>
    <div class="usertext-body" id="body">${RD_BODY}</div>
  </div>
</body></html>`;

test('site rules: a Reddit post keeps its title and body, and loses its score, tagline and timestamp', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();

  try {
    await setExtensionSettings(page, settings(endpoint));
    await serve(context, 'https://old.reddit.com/**', REDDIT_PAGE);

    await page.goto('https://old.reddit.com/r/rust/');
    await page.waitForSelector('#ai-translator-float-ball');
    await page.waitForSelector('#thing .ai-translator-inline-block', { timeout: 30000 });

    const all = sentTexts.join('\n');
    expect(all).toContain(RD_TITLE);
    expect(all).toContain(RD_BODY);
    // `.score` / `.tagline` / `time` / `faceplate-timeago` 四条都在排除表里。没有
    // 规则时这三块都会被翻：它们各自有直属文本，通用启发式看不出和正文的区别。
    expect(all).not.toContain(RD_SCORE);
    expect(all).not.toContain(RD_TAGLINE);
    expect(all).not.toContain(RD_AGO);
    await expect(page.locator('#score .ai-translator-inline-block')).toHaveCount(0);
    await expect(page.locator('#tagline .ai-translator-inline-block')).toHaveCount(0);
    await expect(page.locator('#ago .ai-translator-inline-block')).toHaveCount(0);
  } finally {
    await close();
  }
});

const NR_AUTHOR = 'u/Stunning_Log_9814';
const NR_AGO = '4 hr. ago';
const NR_MENU = ['Award this post', 'Hide this post', 'Report this post'];
const NR_TITLE = 'Which editor do you reach for when a client sends forty hours of raw footage';
const NR_BODY = 'I have tried three of them this month and every one of them stalls on the proxy step.';
const NR_EDITED = 'The export presets were updated';
const NR_EDITED_AGO = 'two hours ago';

// 新版 Reddit 的一张信息流卡片，形状照 r/VideoEditors 实测的 DOM 缩出来：
//
//   - <shreddit-post> 把卡片各段 slot 进自己 shadow 里的版式。卡片头
//     `span[slot=credit-bar]` 装着作者名、「•」、<faceplate-timeago> 和「更多」菜单；
//     它的直接子元素只有 <span>，通则会把整行当一个内联块整块翻。
//   - 「更多」菜单 <faceplate-menu slot="content"> 分进 <rpl-dropdown> shadow 里一个
//     hidden 的弹层，点开之前没有渲染。菜单项自己的 display 是正常的。
//
// 实测这一行被翻成「u/xxx • 4 小时。 过去 奖励这个。 帖子<span1111>报告」：时间戳被
// 拆开翻，看不见的菜单项进了原文。这条旅程守住规则那一半：卡片头整行不收，一个字
// 都不送。看不见的 slot 和粘号标记各有一条夹具（page-coverage-harness /
// markup-preservation）。
//
// 正文里那段 `#edited` 守的是另一件事：站点排除的元素出现在一个照翻的块**里面**
// 时，它是占位符，原样克隆回译文——而不是被当成正文的一部分翻掉。
const NEW_REDDIT_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>r/VideoEditors</title>
<script>
  customElements.define('shreddit-post', class extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' }).innerHTML =
        '<article><slot name="credit-bar"></slot><slot name="title"></slot><slot name="text-body"></slot></article>';
    }
  });
  customElements.define('rpl-dropdown', class extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' }).innerHTML =
        '<slot></slot><div id="hovercard" hidden><slot name="content"></slot></div>';
    }
  });
</script></head>
<body>
  <shreddit-post id="post">
    <span slot="credit-bar" id="credit" class="flex justify-between">
      <span class="flex flex-wrap">
        <a class="author" href="/user/Stunning_Log_9814/">${NR_AUTHOR}</a>
        <span class="created-separator" aria-hidden="true">•</span>
        <faceplate-timeago><time datetime="2026-09-25T08:21:21Z">${NR_AGO}</time></faceplate-timeago>
      </span>
      <span class="flex items-center">
        <rpl-dropdown>
          <button aria-label="Open post options"><svg width="16" height="16"></svg></button>
          <faceplate-menu slot="content">
            ${NR_MENU.map((item) => `<li><span class="label">${item}</span></li>`).join('')}
          </faceplate-menu>
        </rpl-dropdown>
      </span>
    </span>
    <a slot="title" id="title" href="/r/VideoEditors/comments/1wpqr9n/">${NR_TITLE}</a>
    <div slot="text-body" id="body"><div class="md">
      <p id="para">${NR_BODY}</p>
      <p id="edited">${NR_EDITED} <faceplate-timeago id="edited-ago"><time datetime="2026-09-25T10:00:00Z">${NR_EDITED_AGO}</time></faceplate-timeago> to cover the new codec as well.</p>
    </div></div>
  </shreddit-post>
</body></html>`;

test('site rules: a new-Reddit feed card keeps its title and body, and its credit bar is not sent at all', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();

  try {
    await setExtensionSettings(page, settings(endpoint));
    await serve(context, 'https://www.reddit.com/**', NEW_REDDIT_PAGE);

    await page.goto('https://www.reddit.com/r/VideoEditors/');
    await page.waitForSelector('#ai-translator-float-ball');
    // 译文插在块里还是块旁边由版式决定，这里只按内容认它。
    const translationOf = (text) => page.locator('.ai-translator-inline-block').filter({ hasText: text });
    await translationOf(NR_BODY).waitFor({ timeout: 30000 });
    await translationOf(NR_EDITED).waitFor({ timeout: 30000 });

    const all = sentTexts.join('\n');
    expect(all).toContain(NR_TITLE);
    expect(all).toContain(NR_BODY);
    // 卡片头：作者名、时间戳、菜单项，一个字都没送出去。
    expect(all).not.toContain(NR_AUTHOR);
    expect(all).not.toContain(NR_AGO);
    for (const item of NR_MENU) expect(all).not.toContain(item);
    await expect(page.locator('#credit .ai-translator-inline-block')).toHaveCount(0);

    // 块里的时间戳：送出去的是占位符，译文里是原来那个元素的克隆。
    const editedSent = sentTexts.find((text) => text.includes(NR_EDITED));
    expect(editedSent).toMatch(/\{\{\d+\}\}/);
    expect(editedSent).not.toContain(NR_EDITED_AGO);
    await expect(translationOf(NR_EDITED).locator('faceplate-timeago')).toHaveText(NR_EDITED_AGO);
  } finally {
    await close();
  }
});
