// 只写给读屏器的字，落在真页面上（D-429）。
//
// Reddit 的按钮里藏着 <faceplate-screen-reader-content>「Go to comments」这类读屏
// 说明：绝对定位、1px、clip 成零面积。眼睛看不见，收集器却把它当正文收进来，
// 译文就排在按钮旁边，成了一串谁也没写过的可见文字。
//
// 认法是计算样式（content/page/reader-hidden.js，判定本身的边界在
// test/unit/reader-hidden.test.mjs）。这条 spec 钉的是两处接线：
//
//   - 收块（collect.js 的 processElement）：整个元素只写给读屏器，整块不收；
//   - 读文本（processNode）：可见的块里夹着一段读屏文字，只剔掉那一段。
//
// 反例同样要断言：绝对定位 + 溢出裁掉、但是正常大小的角标，和裁出一块有面积的
// 矩形，都是眼睛看得见的字，必须照送。
//
// 用的是自动翻译：www.reddit.com 在内置表里是 `state: 'always'`。
const { test, expect } = require('./fixtures');
const { setExtensionSettings } = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');

const POST_TITLE = 'Which quarterback has quietly improved the most since the start of the season';
const POST_BODY = 'Every week the numbers say one thing and the highlight reels say something completely different.';

// 只写给读屏器的字：每种裁法各一段，都必须一个字不送。
const SR_REDDIT = 'Go to comments for this post';
const SR_CLIP = 'Opens the award dialog for this post';
const SR_CLIP_PATH = 'Share this post with other people';
const SR_TINY = 'Upvote this post and join the discussion';
const SR_INLINE = 'this link opens in a new tab';
// 看得见的字：必须照送。
const VISIBLE_BADGE = 'Pinned by the moderators of this community';
const VISIBLE_CLIPPED = 'Only the top part of this caption is clipped away';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>r/nfl</title>
<style>
  /* Reddit 的原样写法。 */
  faceplate-screen-reader-content {
    position: absolute; width: 1px; height: 1px; overflow: hidden;
    clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap;
  }
  .only-clip { position: absolute; clip: rect(1px, 1px, 1px, 1px); }
  .only-clip-path { clip-path: inset(50%); }
  .only-tiny { position: absolute; width: 1px; height: 1px; overflow: hidden; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  .badge { position: absolute; overflow: hidden; width: 320px; height: 40px; }
  .clipped { position: absolute; clip: rect(0px, 400px, 20px, 0px); width: 400px; }
  #post { position: relative; }
</style>
</head>
<body>
  <main id="main-content">
    <article id="post">
      <h2 id="post-title">${POST_TITLE}</h2>
      <p id="post-body">${POST_BODY} <a href="https://example.com/" id="ext">Read the full breakdown<span class="sr-only">${SR_INLINE}</span></a></p>
      <p>${POST_BODY.replace('Every week', 'Some weeks')}</p>
      <div id="actions">
        <a href="/r/nfl/comments/1/" id="comments"><span>12</span><faceplate-screen-reader-content>${SR_REDDIT}</faceplate-screen-reader-content></a>
        <p class="only-clip" id="sr-clip">${SR_CLIP}</p>
        <p class="only-clip-path" id="sr-clip-path">${SR_CLIP_PATH}</p>
        <p class="only-tiny" id="sr-tiny">${SR_TINY}</p>
      </div>
      <p class="badge" id="badge">${VISIBLE_BADGE}</p>
      <p class="clipped" id="clipped">${VISIBLE_CLIPPED}</p>
    </article>
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

test('screen-reader-only text is neither sent nor shown; visible clipped text still is', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();

  try {
    await setExtensionSettings(page, settings(endpoint));
    await context.route('https://www.reddit.com/**', (route) => {
      route.fulfill({ status: 200, contentType: 'text/html', body: PAGE });
    });

    await page.goto('https://www.reddit.com/r/nfl/');
    await page.waitForSelector('#ai-translator-float-ball');
    await page.waitForSelector('#post .ai-translator-inline-block', { timeout: 30000 });
    // 反例两段落地之后再断言：此时整页一轮已经收完。
    await expect.poll(() => sentTexts.join('\n'), { timeout: 30000 }).toContain(VISIBLE_CLIPPED);

    const all = sentTexts.join('\n');
    expect(all).toContain(POST_TITLE);
    expect(all).toContain('Read the full breakdown');
    expect(all).toContain(VISIBLE_BADGE);
    for (const hidden of [SR_REDDIT, SR_CLIP, SR_CLIP_PATH, SR_TINY, SR_INLINE]) {
      expect(all, hidden).not.toContain(hidden);
    }

    // 页面上也没有一个译文节点带着它们。
    const shown = await page.evaluate(() => [...document.querySelectorAll(
      '.ai-translator-inline-block, .ai-translator-inline-right',
    )].map((node) => node.textContent).join('\n'));
    expect(shown).toContain('Read the full breakdown');
    for (const hidden of [SR_REDDIT, SR_CLIP, SR_CLIP_PATH, SR_TINY, SR_INLINE]) {
      expect(shown, hidden).not.toContain(hidden);
    }
  } finally {
    await close();
  }
});
