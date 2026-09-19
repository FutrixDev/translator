// 自动翻译的第二条旅程：**滚动续译**。
//
// 一篇五千段的长文、一条无限滚动的时间线，用户永远只看得到其中一小块。整页翻译
// 的做法是一次全收全发——在自动翻译里那就是打开一个页面烧掉几十次请求，其中大半
// 用户一眼都不会看。所以发现层是两个观察器：变动的归 MutationObserver，轮到谁的
// 归 IntersectionObserver（上下各留一屏）。
//
// 这条 spec 把两个观察器分开钉：
//
//   · 远处的那一段，**在滚到之前必须一个字都没发出去**。只断言「滚过去之后翻好
//     了」会放过「其实一开始就全翻了」的实现——而那正是这一层存在的理由。
//   · 后来才长出来的那一段（无限滚动、评论懒加载），不需要任何人再点一次。
const { test, expect } = require('./fixtures');
const { setExtensionSettings } = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');

const ORIGIN = 'https://auto.test';

const NEAR = 'The lighthouse keeper logs the weather twice a day in a hardbound notebook.';
const FAR = 'Thirty pages further on, the same handwriting records the winter the harbour froze.';
const LATE = 'A later entry, added long after the notebook had been shelved and forgotten.';

// 3000px 的垫片：视口 720 高，带宽再往下放一屏也只到 1440。远处那段稳稳在带外。
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Keeper's log</title></head>
<body>
  <div id="near-box"><p id="near">${NEAR}</p></div>
  <div id="spacer" style="height:3000px"></div>
  <div id="far-box"><p id="far">${FAR}</p></div>
</body></html>`;

test('auto translation: only what the reader is near gets translated, and later content follows', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();

  try {
    await setExtensionSettings(page, {
      apiEndpoint: endpoint,
      apiKey: 'test-key',
      modelName: 'gpt-4.1-mini',
      targetLang: 'zh-CN',
      skipTargetLanguageText: false,
      siteRules: { 'auto.test': 'always' },
    });
    await context.route(`${ORIGIN}/**`, (route) => {
      route.fulfill({ status: 200, contentType: 'text/html', body: PAGE });
    });

    await page.goto(`${ORIGIN}/log`);
    await page.waitForSelector('#ai-translator-float-ball');

    await page.waitForSelector('#near-box .ai-translator-inline-block', { timeout: 30000 });
    await expect(page.locator('#near-box .ai-translator-inline-block')).toContainText(NEAR);

    // 首屏那一段已经落地了，说明这一轮跑完了——此刻远处那段还没被发出去。
    expect(sentTexts.join('\n')).not.toContain(FAR);
    await expect(page.locator('#far-box .ai-translator-inline-block')).toHaveCount(0);

    // —— 滚过去 ——
    await page.locator('#far').scrollIntoViewIfNeeded();
    await page.waitForSelector('#far-box .ai-translator-inline-block', { timeout: 30000 });
    await expect(page.locator('#far-box .ai-translator-inline-block')).toContainText(FAR);

    // —— 页面自己又长出来一段（懒加载的评论、时间线的下一页）——
    await page.evaluate((text) => {
      const box = document.createElement('div');
      box.id = 'late-box';
      const para = document.createElement('p');
      para.id = 'late';
      para.textContent = text;
      box.appendChild(para);
      document.getElementById('far-box').after(box);
    }, LATE);

    await page.waitForSelector('#late-box .ai-translator-inline-block', { timeout: 30000 });
    await expect(page.locator('#late-box .ai-translator-inline-block')).toContainText(LATE);

    // 已经翻好的那两段没有被后面几轮重新发出去一遍。发现层每一轮都会把它们原样
    // 再送上来，内容身份和调度层的台账是唯一拦住它们的东西——漏了不会有任何可见
    // 症状，只有账单会知道。
    expect(sentTexts.filter((text) => text.includes(NEAR))).toHaveLength(1);
    expect(sentTexts.filter((text) => text.includes(FAR))).toHaveLength(1);
  } finally {
    await close();
  }
});

// 发现层同时观察的块有上限（MAX_OBSERVED = 2000）：IntersectionObserver 持强引用，
// 无限滚动的页面能滚出几万个块，全挂着就是一条永不释放的引用链。超出的那些进
// deferred，等位置让出来时按离视口远近换进来。
//
// 这条 spec 钉的是「换进来」这件事在**内部滚动容器**里也成立。候选常常长在一个自己
// 滚的容器里（侧栏、面板、信息流），那种页面上滚它不会改变 window.scrollY —— 只量
// window 的话，超出上限的那一截就永远卡在 deferred 里：留下的块一个都没进带，没有
// 别的路会排重排，读者跳到那儿看到的是一片原文，而且再也不会变。
// 「这一轮停下来了」= 连着一秒多没有新的请求发出去。
//
// 跳转之前必须先停稳。发现层在装载时就排了一次重排（把 deferred 里离视口最近的
// 换上来），那个 400ms 的定时器要是正好落在跳转之后才去量几何，量到的就是跳完的
// 位置 —— 于是最后一条会被那次重排顺手捎上，滚动监听整个坏掉也照样通过。用例就
// 什么都证不了了。
async function waitUntilQuiet(read, { quietMs = 1200, timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = read();
  let since = Date.now();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const now = read();
    if (now !== last) {
      last = now;
      since = Date.now();
      continue;
    }
    if (Date.now() - since >= quietMs) return;
  }
  throw new Error('页面一直没停下来');
}

const CAP_TARGET = 'The final entry was written the night the lamp was decommissioned for good.';
const FILLER_COUNT = 2100;

function overflowPage() {
  const fillers = [];
  for (let i = 0; i < FILLER_COUNT; i++) {
    fillers.push(`<div><p>Index entry ${i}: the keeper noted the wind, the tide and the colour of the sky.</p></div>`);
  }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Keeper's index</title></head>
<body>
  <div id="scroller" style="height:600px;overflow-y:auto">
    ${fillers.join('\n    ')}
    <div id="cap-box"><p id="cap-target">${CAP_TARGET}</p></div>
  </div>
</body></html>`;
}

test('auto translation: past the observer cap, a jump inside a scrolling container still brings content in', async ({ page, context }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();
  // 这一段是整套里唯一会走到滚动监听那几行的地方 —— 那里任何一个拼错的标识符都是
  // 每次滚动抛一次，而页面上看不出来。
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  try {
    await setExtensionSettings(page, {
      apiEndpoint: endpoint,
      apiKey: 'test-key',
      modelName: 'gpt-4.1-mini',
      targetLang: 'zh-CN',
      skipTargetLanguageText: false,
      siteRules: { 'auto.test': 'always' },
    });
    await context.route(`${ORIGIN}/**`, (route) => {
      route.fulfill({ status: 200, contentType: 'text/html', body: overflowPage() });
    });

    await page.goto(`${ORIGIN}/index`);
    await page.waitForSelector('#ai-translator-float-ball');

    // 容器顶上那几条先翻好，说明这一轮跑完了。最后那一条此刻在 deferred 里。
    await page.waitForSelector('#scroller .ai-translator-inline-block', { timeout: 30000 });
    await waitUntilQuiet(() => sentTexts.length);
    expect(sentTexts.join('\n')).not.toContain(CAP_TARGET);

    // —— 一跃到底。滚的是容器，window.scrollY 一动不动 ——
    await page.evaluate(() => {
      const el = document.getElementById('scroller');
      el.scrollTop = el.scrollHeight;
    });

    await page.waitForSelector('#cap-box .ai-translator-inline-block', { timeout: 30000 });
    await expect(page.locator('#cap-box .ai-translator-inline-block')).toContainText(CAP_TARGET);
    expect(pageErrors).toEqual([]);
  } finally {
    await close();
  }
});
