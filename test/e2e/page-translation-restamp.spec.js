const { test, expect } = require('@playwright/test');
const { contentHarnessScripts, PAGE_TRANSLATION_MODULES } = require('./helpers');

// Focused DOM unit test of the REAL insertTranslationBlock, loaded straight
// from source into a plain headless page.
//
// 收集端和落笔端之间隔着一次网络往返。用户在一轮整页翻译跑着的时候把目标语言
// 从中文改成日文，调度层按 RESTART_KEYS 另起一轮，两轮于是同时在飞——某一块
// 被新一轮收走之后、它的译文回来之前，旧那一轮的中文译文抢先落了地。
//
// 落笔端要是只看 `.ai-translator-translated` 就一律拒收，这一轮静默地什么都没
// 写，而调用方照样把这一块记成「有结果了」。页面上那条中文译文从此没有任何
// 东西会再动它：收集端下一轮同样先看 class，连指纹都懒得算。整页看起来是「改
// 了语言但有几块没跟上」，且刷新之前永远如此。
//
// 三个方向一起钉，少一个都会放过一类退化：
//   · 语言不一样 → 换掉，而且是**换**（旧译文摘干净，不是旁边再长一条）。
//   · 同内容同语言 → 原样跳过。去重是这道门本来的职责，不能为了上一条丢掉。
//   · 没人说语言 → 也跳过。BlockIdentity 把「没说」读作不比语言这一维，落笔端
//     要是把它当成「语言不一样」，每一次重复插入都会把页面上的译文摘掉重画。
const SCRIPTS = contentHarnessScripts(...PAGE_TRANSLATION_MODULES);

const FIXTURE_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <p id="para">The harbour lights stayed exactly where the evening tide had left them.</p>
</body></html>`;

async function insertTwice(page, first, second) {
  await page.setContent(FIXTURE_HTML, { waitUntil: 'load' });
  for (const s of SCRIPTS) await page.addScriptTag({ path: s });

  return page.evaluate(({ a, b }) => {
    const ctx = window.AI_TRANSLATOR_CONTENT;
    const pick = () => ctx.collectTranslatableBlocks(document.body)
      .find((block) => block.element.id === 'para');

    const block = pick();
    ctx.insertTranslationBlock(block, a.text, a.lang === undefined ? {} : { lang: a.lang });
    // 第二轮拿的是**它自己收的**那份 block：真实世界里两轮各收各的。
    ctx.insertTranslationBlock(pick() || block, b.text, b.lang === undefined ? {} : { lang: b.lang });

    const shown = Array.from(document.querySelectorAll('.ai-translator-inline-block'))
      .map((el) => el.textContent.trim());
    const entry = globalThis.BlockIdentity.lookup(document.getElementById('para'));
    return { shown, lang: entry ? entry.lang : null, translated: document.getElementById('para').classList.contains('ai-translator-translated') };
  }, { a: first, b: second });
}

test('an in-flight translation in the old language is replaced, not silently refused', async ({ page }) => {
  const out = await insertTwice(
    page,
    { text: '[旧] 港口的灯还停在潮水离开时的位置。', lang: 'zh-CN' },
    { text: '[新] 港の灯は夕潮が残した場所にそのままあった。', lang: 'ja' }
  );

  expect(out.shown).toHaveLength(1);
  expect(out.shown[0]).toContain('[新]');
  expect(out.shown[0]).not.toContain('[旧]');
  // 身份也要跟着换，否则下一轮收集端还以为这一块是中文的，再摘再画一遍。
  expect(out.lang).toBe('ja');
  expect(out.translated).toBe(true);
});

test('the same content in the same language is still deduplicated', async ({ page }) => {
  const out = await insertTwice(
    page,
    { text: '[第一次] 港口的灯还停在潮水离开时的位置。', lang: 'zh-CN' },
    { text: '[第二次] 港口的灯还停在潮水离开时的位置。', lang: 'zh-CN' }
  );

  expect(out.shown).toHaveLength(1);
  expect(out.shown[0]).toContain('[第一次]');
  expect(out.lang).toBe('zh-CN');
});

test('a caller that names no language is deduplicated too', async ({ page }) => {
  const out = await insertTwice(
    page,
    { text: '[第一次] 港口的灯还停在潮水离开时的位置。' },
    { text: '[第二次] 港口的灯还停在潮水离开时的位置。' }
  );

  expect(out.shown).toHaveLength(1);
  expect(out.shown[0]).toContain('[第一次]');
  expect(out.lang).toBe(null);
});
