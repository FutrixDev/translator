const { test, expect } = require('@playwright/test');
const { contentHarnessScripts, contentStylesheet, PAGE_TRANSLATION_MODULES } = require('./helpers');

// 译文把一行切成省略号（D-429，fit guard 第五节）。
//
// X 信息流、Reddit 卡片头里满是 `white-space:nowrap; overflow:hidden;
// text-overflow:ellipsis` 的格子。译文插进去，格子一个像素不变，多出来的切掉：
// 用户看到「Steelers 钢...」——原文和译文各剩半截。几何上什么都没溢出，
// 所以前四条判据一条都够不着。
//
// 真的 collect + insert + fit guard，从源码加载进一张白页（不装扩展、不走网络）。
// 断言的是用户看得见的：挤不下的格子里没有译文、也没被切；放得下的格子译文照留。
const SCRIPTS = contentHarnessScripts(
  'content/content-clip-guard.js',
  'content/content-fit-guard.js',
  ...PAGE_TRANSLATION_MODULES,
);

const CELL = 'white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0;';

const FIXTURE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body { font: 15px/20px sans-serif; margin: 0; padding: 16px; }
.row { display: flex; gap: 4px; align-items: center; }
</style>
<style>__CONTENT_CSS__</style>
</head><body>
<div class="row"><div id="tight" style="${CELL} width: 180px">Pittsburgh Steelers fans</div><span id="tight-after">·</span></div>
<div class="row"><div id="wide" style="${CELL} width: 700px">Pittsburgh Steelers fans everywhere</div></div>
<div class="row"><div id="scroller" style="white-space:nowrap; overflow-x:auto; width: 180px">Pittsburgh Steelers fans</div></div>
</body></html>`;

test('a translation that would cut a nowrap/ellipsis cell is not left there; one that fits stays', async ({ page }) => {
  await page.setContent(FIXTURE_HTML.replace('__CONTENT_CSS__', contentStylesheet()), { waitUntil: 'load' });
  for (const s of SCRIPTS) await page.addScriptTag({ path: s });

  const result = await page.evaluate(() => {
    const ctx = window.AI_TRANSLATOR_CONTENT;
    const cut = (id) => {
      const el = document.getElementById(id);
      return el.scrollWidth - el.clientWidth;
    };
    const before = { tight: cut('tight'), wide: cut('wide'), scroller: cut('scroller') };
    const blocks = ctx.collectTranslatableBlocks(document.body);
    blocks.forEach((b) => ctx.insertTranslationBlock(b, '[T] ' + b.text, { textLang: 'zh-CN' }));
    const ours = (id) => {
      const el = document.getElementById(id);
      const nodes = [...el.querySelectorAll('.ai-translator-inline-block, .ai-translator-inline-right')];
      const next = el.nextElementSibling;
      if (next && next.matches('.ai-translator-inline-block, .ai-translator-inline-right')) nodes.push(next);
      return nodes.filter((n) => n.isConnected && n.getBoundingClientRect().width > 0).length;
    };
    const shown = (id) => {
      const el = document.getElementById(id);
      return el.getBoundingClientRect().width > 0 && getComputedStyle(el).display !== 'none';
    };
    return {
      collected: blocks.map((b) => b.element.id || b.element.parentElement.id),
      before,
      after: { tight: cut('tight'), wide: cut('wide'), scroller: cut('scroller') },
      ours: { tight: ours('tight'), wide: ours('wide'), scroller: ours('scroller') },
      shown: { tight: shown('tight'), wide: shown('wide') },
    };
  });

  // 前提：三格都收了，插之前谁也没被切
  expect(result.collected).toEqual(expect.arrayContaining(['tight', 'wide', 'scroller']));
  expect(result.before).toEqual({ tight: 0, wide: 0, scroller: 0 });

  // 挤不下的那格：译文不在，原文完整，格子没被切
  expect(result.ours.tight).toBe(0);
  expect(result.shown.tight).toBe(true);
  expect(result.after.tight).toBeLessThanOrEqual(1);

  // 放得下的那格：译文照留，也没被切
  expect(result.ours.wide).toBe(1);
  expect(result.after.wide).toBeLessThanOrEqual(1);

  // 能横向滚动的格子切不掉谁，不归这条判据管
  expect(result.ours.scroller).toBe(1);
});
