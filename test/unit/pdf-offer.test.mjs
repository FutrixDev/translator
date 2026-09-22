// 一份 PDF 上那条「翻译这篇文档」的提示条，以及它守的那条铁律：
//
//   **入口可以自己出现，任务永远不自己开始。**
//
// PDF 走的是服务端排版任务，按页扣额度，而额度是钱。PRD 的验收项写得很死：
// arXiv 的 /pdf/ 页面上「无任何自动网络请求发往 PDF 任务接口」。所以这一套
// 测试问三件事——那一页不会被整页翻译的调度器碰到（路径级 never）、条子自己
// 不发请求（只有 accept() 里那一句）、以及四个入口走的是同一串检查。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { workerSource, messageCatalog, contentBundle, contentCss } from './helpers/sources.mjs';

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

await import('../../shared/lang-tags.js');
await import('../../shared/site-rules-builtin.js');
await import('../../shared/site-rules.js');
await import('../../shared/pdf-url.js');
const { SiteRules, PdfUrl } = globalThis;
const R = SiteRules.REASONS;

// ---------------------------------------------------- 路径级 never

test('arXiv 的 /pdf/ 不走整页翻译，而它的 /abs/ 照常走', () => {
  const ask = (path) => SiteRules.decide({
    host: 'arxiv.org', path, pageLang: 'en', targetLang: 'zh-CN',
    userRules: {}, settings: { autoTranslate: true, autoTranslateLangs: [] }, explicit: false,
  });
  const pdf = ask('/pdf/2501.00001');
  assert.equal(pdf.verdict, 'off');
  assert.equal(pdf.reason, R.BUILTIN_NEVER);
  assert.equal(ask('/abs/2501.00001').verdict, 'auto');
});

test('内置的 never 用户翻不过来，而它不是黑名单', () => {
  // 两件事都要真：用户在 arxiv.org 上点过「总是翻译」，那一页照样不翻（never
  // 是「这一页不走这条路」，不是一条可以覆盖的偏好）；但它说出来的理由不能是
  // 「这个网站被拉黑了」—— 那句话在 /abs/ 上是假的，而条子上照着理由说话。
  const over = SiteRules.decide({
    host: 'arxiv.org', path: '/pdf/2501.00001', pageLang: 'en', targetLang: 'zh-CN',
    userRules: { 'arxiv.org': 'always' },
    settings: { autoTranslate: true, autoTranslateLangs: [] }, explicit: false,
  });
  assert.equal(over.verdict, 'off');
  assert.equal(over.reason, R.BUILTIN_NEVER);

  // 「这一行写不了」问的是同一个所有者，所以那条规则下面的站点开关是灰的。
  assert.equal(SiteRules.siteRuleWritable('arxiv.org', '/pdf/1'), false);
  assert.equal(SiteRules.siteRuleWritable('arxiv.org', '/abs/1'), true);
});

test('BUILTIN_NEVER 算「被拒」，否则字幕引擎会在这一页上自己开工', () => {
  // content/captions/activation.js 的 siteRefused() 读的是 decide() 给的
  // refused 那一位，而它由 REFUSALS 决定。少收这一档，一份 PDF 上的 <video>
  // 就会自己开始往第三方送字幕。
  const pdf = SiteRules.decide({
    host: 'arxiv.org', path: '/pdf/2501.00001', pageLang: 'en', targetLang: 'zh-CN',
    userRules: {}, settings: { autoTranslate: true, autoTranslateLangs: [] }, explicit: false,
  });
  assert.equal(pdf.refused, true);

  // 而界面得有话说 —— 每个理由都要有一句对应的文案，少一个条子上就是空白。
  const status = repoFile('content/content-auto-status.js');
  for (const reason of Object.keys(R)) {
    assert.match(status, new RegExp(`\\b${reason}: '`), `REASON_KEYS 里没有 ${reason}`);
  }
  const catalog = messageCatalog();
  for (const lang of Object.keys(catalog)) {
    for (const k of ['autoReasonBuiltinNever', 'pdfAskPrompt']) {
      assert.ok(catalog[lang][k], `${lang} 缺 ${k}`);
    }
  }
});

// ---------------------------------------------------- 点了才跑

test('提示条自己不发请求 —— 唯一那一句在 accept() 里', () => {
  const src = repoFile('content/content-pdf-prompt.js');
  const sends = [...src.matchAll(/chrome\.runtime\.sendMessage/g)];
  assert.equal(sends.length, 1, '提示条里出现了第二处 sendMessage');
  const accept = src.slice(src.indexOf('function accept('), src.indexOf('function dismiss('));
  assert.match(accept, /chrome\.runtime\.sendMessage/, '那一句不在 accept() 里');
  // fetch 一次都不能有：这一层的职责是问，不是办。
  assert.equal(/\bfetch\s*\(/.test(src), false);
});

test('提示条只在真是一份 PDF 文档、而且开关开着的时候出现', () => {
  const src = repoFile('content/content-pdf-prompt.js');
  assert.match(src, /enablePdfTranslation/);
  assert.match(src, /PdfUrl\.isLikelyPdfUrl/);
  assert.match(src, /application\/pdf/);
});

test('条子让位给 offer，而且不花掉这个站点的追问额度', () => {
  const src = repoFile('content/content-auto-status.js');
  // 模式阶梯：offer 排在 ask 前面。一份 PDF 上的正文是空的，「翻译这一页？」
  // 点下去一个字也出不来。
  assert.match(src, /offer \? 'offer' : \(asking \? 'ask' : ''\)/);
  // 要号那一步压在 mode === 'ask' 下面，所以 offer 不经过它。
  assert.match(src, /mode === 'ask' && askSlot/);
  // 勾选框在 offer 下藏起来（「记住这个站点」在一份文档上没有对应的意思），
  // 而两个按钮正是它要的，不能跟着藏。
  const css = contentCss();
  assert.match(css, /\[data-mode="notice"\], \[data-mode="offer"\]\) \.ai-translator-auto-remember/);
  assert.equal(
    /\[data-mode="offer"\][^\n]*data-act="translate"/.test(css), false,
    'offer 把自己的按钮藏掉了');
});

// ---------------------------------------------------- 一串检查只有一份

test('四个入口走同一个 startPdfUrlTranslation()', () => {
  const menus = repoFile('background/context-menus.js');
  assert.match(menus, /startPdfUrlTranslation\(/);
  for (const own of ['getOrCreateUrlOperationId', 'runPdfUrlJob', 'notifyPdfStarted']) {
    assert.equal(menus.includes(own), false, `右键菜单又自己做了一遍 ${own}`);
  }
  // 提示条那一路：内容脚本发消息，worker 落到同一个函数上。
  assert.match(repoFile('content/content-pdf-prompt.js'), /PDF_TRANSLATE_URL/);
  assert.match(workerSource(), /case 'PDF_TRANSLATE_URL':/);
  const worker = workerSource();
  const arm = worker.slice(worker.indexOf("case 'PDF_TRANSLATE_URL':"));
  assert.match(arm.slice(0, 400), /startPdfUrlTranslation\(/);
  // 网址以浏览器说的那一页为准 —— 要花钱的一步上，内容脚本报的只作兜底。
  assert.match(arm.slice(0, 400), /sender\.tab && sender\.tab\.url/);
});

test('「这是不是一份 PDF」只有一份实现', () => {
  // 以前 background/ 和 pdf/pdf-ui.js 各抄了一遍，其中一份的注释还指着一个早就
  // 搬走的文件。内容脚本本来会是第三份。
  const owners = [];
  for (const dir of ['background', 'content', 'options', 'popup', 'pdf', 'shared']) {
    for (const name of readdirSync(fileURLToPath(new URL(`../../${dir}`, import.meta.url)))) {
      if (!name.endsWith('.js')) continue;
      const src = repoFile(`${dir}/${name}`);
      if (/function isLikelyPdfUrl\s*\(/.test(src)) owners.push(`${dir}/${name}`);
    }
  }
  assert.deepEqual(owners, ['shared/pdf-url.js']);
});

test('用到它的每一面都装了 shared/pdf-url.js', () => {
  assert.match(repoFile('background/pdf-jobs.js'), /import '\.\.\/shared\/pdf-url\.js'/);
  assert.ok(contentBundle().includes('shared/pdf-url.js'),
    '内容脚本没装 pdf-url.js，提示条读 globalThis.PdfUrl 会是 undefined');
  for (const page of ['options/options.html', 'popup/popup.html', 'pdf/upload.html']) {
    assert.match(repoFile(page), /shared\/pdf-url\.js/, `${page} 没装 pdf-url.js`);
  }
});

test('提示条排在画条子的那一层后面', () => {
  const bundle = contentBundle();
  assert.ok(bundle.indexOf('content/content-pdf-prompt.js') > bundle.indexOf('content/content-auto-status.js'));
});

test('两个网址判断的边界没变', () => {
  assert.equal(PdfUrl.isLikelyPdfUrl('https://arxiv.org/pdf/2501.00001'), true);
  assert.equal(PdfUrl.isLikelyPdfUrl('https://arxiv.org/abs/2501.00001'), false);
  assert.equal(PdfUrl.isLikelyPdfUrl('https://example.com/a/b.PDF'), true);
  assert.equal(PdfUrl.isLikelyPdfUrl('mailto:a@b.c'), false);
  assert.equal(PdfUrl.isLikelyPdfUrl(''), false);
  assert.equal(PdfUrl.pdfFileNameFromUrl('https://arxiv.org/pdf/2501.00001'), '2501.00001.pdf');
  assert.equal(PdfUrl.pdfFileNameFromUrl('https://example.com/'), 'document.pdf');
});
