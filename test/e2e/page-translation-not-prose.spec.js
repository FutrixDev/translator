// 不是正文的字，落在真页面上（D-429）。
//
// Reddit / X 的信息流里，收集器按标签收块，收进来两类不是给人读的字：
//
//   - 控件上的短标签：「Share」「Join」、排序标签页「Hot」「Rising」。它们排在一行
//     flex 里，译文挂在右边，把整行挤歪；
//   - 只有数字和符号：投票数「1,284」、评论数「12」、规则序号「1」、比分「24 – 17」。
//     译出来还是那几个数，原文旁边同一个数写两遍。
//
// 判定本身的边界在 test/unit/not-prose.test.mjs。这条 spec 钉的是 collect.js 的接线：
// 两条收块路（内联标签、块级标签）和直接文本段都问 ctx.notProse，命中就整块不收——
// 既不送去翻译，页面上也没有译文节点。
//
// 反例同样要断言：整张卡片写成 role=button，卡片里的标题和正文照送；四个词的按钮
// 是一句话，照送；链接不是控件，照送；规则序号旁边的规则正文照送。
//
// 用的是自动翻译：www.reddit.com 在内置表里是 `state: 'always'`。
const { test, expect } = require('./fixtures');
const { setExtensionSettings, sentSegments, ourNodesAt } = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');

const POST_TITLE = 'Which quarterback has quietly improved the most since the start of the season';
const POST_BODY = 'Every week the numbers say one thing and the highlight reels say something completely different.';
const CARD_TITLE = 'Weekly film breakdown thread for the divisional round';
const CARD_BODY = 'Post your clips and explain what the broadcast angle did not show.';
const RULE_TEXT = 'Keep the discussion civil and on topic for everyone here';
const LINK = 'Read the full breakdown';
const LONG_BUTTON = 'Show more of this';
const VOTES_NOTE = 'Upvotes since this post went live early this morning';

// 不收的字：id → 原文。
const SKIPPED = {
  share: 'Share',
  join: 'Join',
  'tab-hot': 'Hot',
  'tab-rising': 'Rising',
  score: '1,284',
  'comment-count': '12',
  'rule-num': '1',
  'game-score': '24 – 17',
};

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>r/nfl</title>
<style>
  faceplate-screen-reader-content {
    position: absolute; width: 1px; height: 1px; overflow: hidden;
    clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap;
  }
  .row { display: flex; gap: 8px; align-items: center; }
</style>
</head>
<body>
  <main id="main-content">
    <div role="tablist" class="row">
      <div role="tab" id="tab-hot">Hot</div>
      <div role="tab" id="tab-rising">Rising</div>
    </div>
    <article id="post">
      <h2 id="post-title">${POST_TITLE}</h2>
      <p id="post-body">${POST_BODY} <a href="https://example.com/" id="ext">${LINK}</a></p>
      <div class="row" id="actions">
        <span id="score">1,284</span>
        <a href="/r/nfl/comments/1/" id="comments"><span id="comment-count">12</span></a>
        <button id="share"><span>Share</span><faceplate-screen-reader-content>Share this post with other people</faceplate-screen-reader-content></button>
        <button id="join">Join</button>
        <button id="long-button">${LONG_BUTTON}</button>
      </div>
    </article>
    <div role="button" id="card" tabindex="0">
      <h3 id="card-title">${CARD_TITLE}</h3>
      <p id="card-body">${CARD_BODY}</p>
    </div>
    <div class="row" id="rule">
      <span id="rule-num">1</span>
      <div id="rule-text">${RULE_TEXT}</div>
    </div>
    <div id="votes">3,410<p id="votes-note">${VOTES_NOTE}</p></div>
    <div class="row" id="game">
      <div id="game-note">Final score from the late game on Sunday night</div>
      <span id="game-score">24 – 17</span>
    </div>
  </main>
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

test('control labels and number-only text are neither sent nor shown; prose around them still is', async ({ page, context }) => {
  const { close, endpoint, sentTexts, fastBatchRequests } = await startMockOpenAIServer();

  try {
    await setExtensionSettings(page, settings(endpoint));
    await context.route('https://www.reddit.com/**', (route) => {
      route.fulfill({ status: 200, contentType: 'text/html', body: PAGE });
    });

    await page.goto('https://www.reddit.com/r/nfl/');
    await page.waitForSelector('#ai-translator-float-ball');
    // 反例全部落地之后再断言：此时整页一轮已经收完。
    for (const id of ['post-title', 'card-title', 'card-body', 'rule-text', 'game-note', 'votes-note']) {
      await expect.poll(() => ourNodesAt(page, id), { timeout: 30000, message: id }).toBeGreaterThan(0);
    }

    const segments = sentSegments(sentTexts, fastBatchRequests).map((s) => s.trim());
    const all = segments.join('\n');
    for (const prose of [POST_TITLE, CARD_TITLE, CARD_BODY, RULE_TEXT, LINK, LONG_BUTTON, VOTES_NOTE]) {
      expect(all, prose).toContain(prose);
    }
    for (const [id, text] of Object.entries(SKIPPED)) {
      expect(segments, `${id} sent`).not.toContain(text);
      expect(await ourNodesAt(page, id), `${id} shown`).toBe(0);
    }

    // 直属文本段（块里夹着 <p> 时 wrapDirectTextRuns 才裹）同样不裹：纯数字的那段
    // 不送，也就不该在页面上多出一个锚点 span。
    expect(segments).not.toContain('3,410');
    expect(await page.locator('#votes > .ai-translator-text-run').count()).toBe(0);

    // 页面上的译文节点里也没有一个是它们。
    const shown = await page.evaluate(() => [...document.querySelectorAll(
      '.ai-translator-inline-block, .ai-translator-inline-right',
    )].map((node) => node.textContent.trim()));
    for (const text of Object.values(SKIPPED)) {
      expect(shown, text).not.toContain(`[T] ${text}`);
    }
    expect(shown.join('\n')).toContain(LONG_BUTTON);
  } finally {
    await close();
  }
});
