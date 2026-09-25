const { test, expect } = require('@playwright/test');
const { contentHarnessScripts, PAGE_TRANSLATION_MODULES } = require('./helpers');

// Focused DOM unit test of the REAL insertTranslationBlock, loaded straight
// from source into a plain headless page.
//
// 收集端和落笔端之间隔着一次网络往返。用户在一轮整页翻译跑着的时候把目标语言
// 从中文改成日文，调度层按 RESTART_KEYS 另起一轮，两轮于是同时在飞——两条译文
// 先后落到同一块上，而先后顺序是网络说了算的。
//
// 两个方向都会把页面卡死，且都是静默的：
//   · 旧那轮先落地、新那轮后到，落笔端要是只看 `.ai-translator-translated` 就
//     一律拒收，这一轮什么都没写，而调用方照样把这一块记成「有结果了」。页面
//     上那条中文从此没有任何东西会再动它——收集端下一轮同样先看 class。
//   · 新那轮先落地、旧那轮后到，落笔端要是「语言不一样就换掉」，就把已经正确
//     的日文又换回了中文，而新那轮的台账早把这一块记成有结果了，同样没人再动。
//
// 所以裁决者是**此刻该译成的那门语言**，不是先来后到。四个方向一起钉：
//   · 我们这条是当前语言、页面上那条不是 → 换掉，而且是**换**（旧译文摘干净，
//     不是旁边再长一条）。
//   · 我们这条不是当前语言 → 不动页面，哪怕语言确实不一样。
//   · 同内容同语言 → 原样跳过。去重是这道门本来的职责，不能为了上面两条丢掉。
//   · 没人说语言 → 也跳过。BlockIdentity 把「没说」读作不比语言这一维，落笔端
//     要是把它当成「语言不一样」，每一次重复插入都会把页面上的译文摘掉重画。
const SCRIPTS = contentHarnessScripts(...PAGE_TRANSLATION_MODULES);

const FIXTURE_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <p id="para">The harbour lights stayed exactly where the evening tide had left them.</p>
</body></html>`;

// current：此刻这一页该译成哪门语言，就是真实运行时 ctx.currentTargetLang() 的
// 答案。引擎（content-translation-engine.js）不在整页翻译这几个模块里，夹具里
// 得自己给一个——真实页面上它一定在，manifest 里排在前面。
async function insertTwice(page, first, second, current) {
  await page.setContent(FIXTURE_HTML, { waitUntil: 'load' });
  for (const s of SCRIPTS) await page.addScriptTag({ path: s });

  return page.evaluate(({ a, b, now }) => {
    const ctx = window.AI_TRANSLATOR_CONTENT;
    ctx.currentTargetLang = () => now;
    const pick = () => ctx.collectTranslatableBlocks(document.body)
      .find((block) => block.element.id === 'para');

    // 两轮**都在任何译文落地之前**就把这一块收走了 —— 竞速就是这么发生的，也
    // 只有这样才轮得到落笔端裁决。收完第一条译文再收第二次的话，收集端自己那
    // 道陈旧判定会先把旧译文摘掉，落笔端根本碰不到这一局。
    const blocks = [pick(), pick()];
    ctx.insertTranslationBlock(blocks[0], a.text, a.lang === undefined ? { textLang: now } : { lang: a.lang, textLang: a.lang });
    ctx.insertTranslationBlock(blocks[1], b.text, b.lang === undefined ? { textLang: now } : { lang: b.lang, textLang: b.lang });

    const shown = Array.from(document.querySelectorAll('.ai-translator-inline-block'))
      .map((el) => el.textContent.trim());
    const entry = globalThis.BlockIdentity.lookup(document.getElementById('para'));
    return { shown, lang: entry ? entry.lang : null, translated: document.getElementById('para').classList.contains('ai-translator-translated') };
  }, { a: first, b: second, now: current });
}

test('an in-flight translation in the old language is replaced, not silently refused', async ({ page }) => {
  const out = await insertTwice(
    page,
    { text: '[旧] 港口的灯还停在潮水离开时的位置。', lang: 'zh-CN' },
    { text: '[新] 港の灯は夕潮が残した場所にそのままあった。', lang: 'ja' },
    'ja'
  );

  expect(out.shown).toHaveLength(1);
  expect(out.shown[0]).toContain('[新]');
  expect(out.shown[0]).not.toContain('[旧]');
  // 身份也要跟着换，否则下一轮收集端还以为这一块是中文的，再摘再画一遍。
  expect(out.lang).toBe('ja');
  expect(out.translated).toBe(true);
});

test('a late response from the old pass does not overwrite the current language', async ({ page }) => {
  // 同一场竞速，只是网络把顺序调了个个儿：新那轮的日文先落地，手动那轮的中文
  // 随后才回来。谁最后到谁说了算的话，这一页就退回了中文，且再没人动它。
  const out = await insertTwice(
    page,
    { text: '[新] 港の灯は夕潮が残した場所にそのままあった。', lang: 'ja' },
    { text: '[旧] 港口的灯还停在潮水离开时的位置。', lang: 'zh-CN' },
    'ja'
  );

  expect(out.shown).toHaveLength(1);
  expect(out.shown[0]).toContain('[新]');
  expect(out.shown[0]).not.toContain('[旧]');
  expect(out.lang).toBe('ja');
});

test('the same content in the same language is still deduplicated', async ({ page }) => {
  const out = await insertTwice(
    page,
    { text: '[第一次] 港口的灯还停在潮水离开时的位置。', lang: 'zh-CN' },
    { text: '[第二次] 港口的灯还停在潮水离开时的位置。', lang: 'zh-CN' },
    'zh-CN'
  );

  expect(out.shown).toHaveLength(1);
  expect(out.shown[0]).toContain('[第一次]');
  expect(out.lang).toBe('zh-CN');
});

test('a caller that names no language is deduplicated too', async ({ page }) => {
  const out = await insertTwice(
    page,
    { text: '[第一次] 港口的灯还停在潮水离开时的位置。' },
    { text: '[第二次] 港口的灯还停在潮水离开时的位置。' },
    'zh-CN'
  );

  expect(out.shown).toHaveLength(1);
  expect(out.shown[0]).toContain('[第一次]');
  expect(out.lang).toBe(null);
});
