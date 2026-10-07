// P1-C 词表 C2：设置页的术语表卡片（设计 docs/plans/2026-09-25-p1-c-glossary.md
// §4.1、§4.2、§6.1 C-J4）。
//
//   C-J4  卡片导出 CSV（下载件的字节：BOM、CRLF、五列表头）→ 改一行、加一行再
//         导入，预览「将新增 1 条、替换 1 条」→ 点「导入」，存储的增量与预览一致
//         → 第 3 行坏掉的文件整份拒绝、存储逐字节不变 → 设置页整份导出、清空
//         词表、整份导入，glossary 一节往返后条目逐字段相同，预览行数字对得上。
//   另几条卡片用例：删除；编辑（表单照原条目预填站点和目标语言；改站点这个键的
//   组成部分：还是那一条、id 不变、u 是有限数 —— O-1）；撞键（改成另一条的原文，
//   表单下方说重复，存储不动）；站点写了但规范化后什么都不剩（'...'）：失焦不清空，
//   保存时表单下方说不合法，存储不动；原文、译文里的 HTML 照字面显示，不生成元素；
//   切界面语言，卡片上的按钮跟着换；超过 1 MiB 的 CSV 不读就按超额拒绝。
//
// 入口全部是设置页上的真实点选：文件经「导入 CSV」「导入」两个按钮弹出的文件选择
// 器交给 Playwright（waitForEvent('filechooser') + FileChooser.setFiles），不绕过
// 按钮直接往 <input type=file> 里塞；下载用 waitForEvent('download') 读下载件本身。
// 界面语言设成简体中文，断言承诺文案的原句。
const fs = require('fs');
const { test, expect } = require('./fixtures');
const {
  setExtensionSettings,
  syncSnapshot,
} = require('./helpers');
const { addGlossaryEntryInCard, openGlossaryCard, storedGlossary } = require('./glossary-helpers');
const { expectLaidOut } = require('./layout-checks');

const HEADER = 'source,target,case_sensitive,site,target_lang';

function report(label, text) {
  console.log(`${label}: ${text}`);
  test.info().annotations.push({ type: label, description: text });
}

async function centre(page, selector) {
  await page.locator(selector).evaluate((el) => el.scrollIntoView({ block: 'center' }));
}

/** 点卡片的「导出 CSV」，读下载下来的那个文件：{name, bytes}。 */
async function exportCsv(page) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#glossaryExport')]);
  return { name: download.suggestedFilename(), bytes: fs.readFileSync(await download.path()) };
}

/** 点卡片的「导入 CSV」，在弹出的文件选择器里选这份文本。 */
async function importCsv(page, text, name = 'blab-glossary-edited.csv') {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#glossaryImport')]);
  await chooser.setFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(text, 'utf8') });
}

/** 设置页整份导出：下载的 JSON。 */
async function exportSettings(page) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#transferExport')]);
  return JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
}

/** 每条只看内容（原文、译文、大小写、站点、语言），按原文排好。 */
function contents(stored) {
  return Object.values(stored)
    .map(({ s, t, c, h, l }) => ({ s, t, c, h, l }))
    .sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : 0));
}

const row = (page, id) => page.locator(`#glossaryList .glossary-entry[data-entry-id="${id}"]`);

test.describe('P1-C glossary card', () => {
  test.beforeEach(async ({ page }) => {
    await setExtensionSettings(page, { uiLanguage: 'zh-CN' });
  });

  test('C-J4 CSV export and import on the card, all or nothing, and the glossary section of a whole-settings round trip', async ({ page, context, extensionId }) => {
    await openGlossaryCard(page, extensionId);
    // 起点：恰好一条，在卡片上加。
    const first = await addGlossaryEntryInCard(page, context, { s: 'attention', t: '注意力', l: 'zh-CN' });
    await expect(page.locator('#glossaryUsage')).toContainText('· 1 / 300');

    // 1. 导出 CSV：下载件以 UTF-8 BOM 开头，每行以 CRLF 结尾，第一行是五列表头。
    const exported = await exportCsv(page);
    expect(exported.name).toMatch(/^blab-glossary-\d{8}\.csv$/);
    expect([...exported.bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const body = exported.bytes.subarray(3).toString('utf8');
    expect(body.endsWith('\r\n')).toBe(true);
    expect(/[^\r]\n/.test(body)).toBe(false);
    expect(body.split('\r\n')).toEqual([HEADER, 'attention,注意力,0,,zh-CN', '']);

    // 2. 改一行（译文）、加一行，再从「导入 CSV」选这份文件：预览 1 新增、1 替换，
    // 这时存储一个字节都还没动。
    const edited = body
      .replace('attention,注意力,0,,zh-CN', 'attention,注意力机制,0,,zh-CN')
      .concat('Transformer,,1,,*\r\n');
    const beforeImport = await syncSnapshot(context);
    await importCsv(page, `${String.fromCharCode(0xfeff)}${edited}`);
    await expect(page.locator('#glossaryPreviewText')).toHaveText('将新增 1 条、替换 1 条。');
    await expect(page.locator('#glossaryError')).toBeHidden();
    expect(await syncSnapshot(context)).toEqual(beforeImport);
    await centre(page, '#glossaryPreview');
    report('C-J4 preview layout', await expectLaidOut(page,
      ['#glossaryPreviewText', '#glossaryImportConfirm', '#glossaryImportCancel'], 'C-J4 preview'));

    // 3. 点「导入」：存储的增量就是预览说的 —— 多出 1 条新键，原来那条 id 不变、
    // 内容换成文件里的。
    await page.click('#glossaryImportConfirm');
    await expect(page.locator('#glossaryPreview')).toBeHidden();
    let afterImport;
    await expect.poll(async () => {
      afterImport = await storedGlossary(context);
      return Object.keys(afterImport).length;
    }).toBe(2);
    const beforeKeys = Object.keys(beforeImport.items).filter((key) => key.startsWith('glossary:'));
    const addedKeys = Object.keys(afterImport).filter((key) => !beforeKeys.includes(key));
    const replacedKeys = beforeKeys.filter((key) => key in afterImport
      && JSON.stringify(afterImport[key]) !== JSON.stringify(beforeImport.items[key]));
    expect({ added: addedKeys.length, replaced: replacedKeys.length }).toEqual({ added: 1, replaced: 1 });
    expect(replacedKeys).toEqual([`glossary:${first.id}`]);
    expect(afterImport[`glossary:${first.id}`]).toEqual({ s: 'attention', t: '注意力机制', l: 'zh-CN', u: expect.any(Number) });
    expect(afterImport[addedKeys[0]]).toEqual({ s: 'Transformer', c: 1, l: '*', u: expect.any(Number) });
    await expect(page.locator('#glossaryList .glossary-entry')).toHaveCount(2);
    await expect(page.locator('#glossaryUsage')).toContainText('· 2 / 300');

    // 4. 第 3 行坏掉（区分大小写一栏既不是 0/1 也不是 true/false）：整份拒绝，
    // 说出行号，存储逐字节不变 —— 第 2 行那条好的也没进去。
    const beforeBad = await syncSnapshot(context);
    await importCsv(page, `${HEADER}\r\ngood,好,0,,*\r\nbad,坏,maybe,,*\r\n`, 'blab-glossary-bad.csv');
    await expect(page.locator('#glossaryError')).toHaveText('第 3 行无效，没有导入任何内容。');
    await expect(page.locator('#glossaryPreview')).toBeHidden();
    expect(await syncSnapshot(context)).toEqual(beforeBad);
    await expect(page.locator('#glossaryList .glossary-entry')).toHaveCount(2);

    // 5. 设置页整份导出：glossary 一节就是卡片导出的那份 CSV。
    const cardCsv = (await exportCsv(page)).bytes.toString('utf8');
    const file = await exportSettings(page);
    expect(file.glossary).toBe(cardCsv);
    const roundTrip = contents(await storedGlossary(context));

    // 在卡片上逐条删掉，清空词表。
    while (await page.locator('#glossaryList .glossary-delete').count()) {
      const n = await page.locator('#glossaryList .glossary-entry').count();
      await page.locator('#glossaryList .glossary-delete').first().click();
      await expect(page.locator('#glossaryList .glossary-entry')).toHaveCount(n - 1);
    }
    await expect(page.locator('#glossaryList .glossary-empty')).toBeVisible();
    await expect.poll(async () => Object.keys(await storedGlossary(context)).length).toBe(0);

    // 整份导入：预览里 glossary 一行是 2 新增、0 替换；确认后两条回来，逐字段相同
    // （id 和 u 是这一次导入新给的，不在比较之列）。
    // 点设置页的「导入」按钮，在它弹出的文件选择器里选文件（按钮没接上，这一步就等不到选择器）。
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#transferImport')]);
    await chooser.setFiles({
      name: 'blab-settings-glossary.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)),
    });
    await expect(page.locator('#transferPreviewList li', { hasText: '术语表：' }))
      .toHaveText('术语表：将新增 2 条、替换 0 条。');
    await page.click('#transferConfirm');
    await expect.poll(async () => Object.keys(await storedGlossary(context)).length).toBe(2);
    const restored = await storedGlossary(context);
    expect(contents(restored)).toEqual(roundTrip);
    for (const entry of Object.values(restored)) expect(Number.isFinite(entry.u)).toBe(true);
    await expect(page.locator('#glossaryList .glossary-entry')).toHaveCount(2);
    await expect(page.locator('#glossaryUsage')).toContainText('· 2 / 300');
  });

  test('card: delete removes the entry from storage and from the list', async ({ page, context, extensionId }) => {
    await openGlossaryCard(page, extensionId);
    const keep = await addGlossaryEntryInCard(page, context, { s: 'attention', t: '注意力' });
    const gone = await addGlossaryEntryInCard(page, context, { s: 'ferry', t: '渡轮' });
    await expect(page.locator('#glossaryUsage')).toContainText('· 2 / 300');

    await row(page, gone.id).locator('.glossary-delete').click();
    await expect(row(page, gone.id)).toHaveCount(0);
    await expect.poll(async () => Object.keys(await storedGlossary(context))).toEqual([`glossary:${keep.id}`]);
    await expect(row(page, keep.id)).toHaveCount(1);
    await expect(page.locator('#glossaryUsage')).toContainText('· 1 / 300');
  });

  test('card: editing a key component keeps the same entry (same id, finite u) and does not add a second one', async ({ page, context, extensionId }) => {
    await openGlossaryCard(page, extensionId);
    const entry = await addGlossaryEntryInCard(page, context, { s: 'attention', t: '注意力', h: 'glossary.test', l: 'zh-CN' });
    expect(entry.stored).toEqual({ s: 'attention', t: '注意力', h: 'glossary.test', l: 'zh-CN', u: expect.any(Number) });

    await row(page, entry.id).locator('.glossary-edit').click();
    const editor = page.locator('.glossary-editor');
    // 表单照原条目预填每一栏：站点、目标语言漏填，一保存就把条目悄悄放宽成所有网站、所有语言。
    await expect(editor.locator('#glossary-source')).toHaveValue('attention');
    await expect(editor.locator('#glossary-target')).toHaveValue('注意力');
    await expect(editor.locator('#glossary-site')).toHaveValue('glossary.test');
    await expect(editor.locator('#glossary-lang')).toHaveValue('zh-CN');
    // 站点是去重键的一部分：改它最容易让「编辑」退化成「另加一条」。失焦时按
    // SiteRules.normalizeHost 回填（设计 §4.1 表单行）。
    await editor.locator('#glossary-site').fill('WWW.Example.com');
    await editor.locator('#glossary-target').focus();
    await expect(editor.locator('#glossary-site')).toHaveValue('example.com');
    await editor.locator('.glossary-save').click();
    await expect(editor).toHaveCount(0);

    let stored;
    await expect.poll(async () => {
      stored = await storedGlossary(context);
      return stored[`glossary:${entry.id}`] && stored[`glossary:${entry.id}`].h;
    }).toBe('example.com');
    expect(Object.keys(stored)).toEqual([`glossary:${entry.id}`]);
    const edited = stored[`glossary:${entry.id}`];
    expect(edited).toEqual({ s: 'attention', t: '注意力', h: 'example.com', l: 'zh-CN', u: expect.any(Number) });
    expect(Number.isFinite(edited.u)).toBe(true);
    expect(edited.u).toBeGreaterThanOrEqual(entry.stored.u);
    await expect(page.locator('#glossaryList .glossary-entry')).toHaveCount(1);
    const zhName = await page.evaluate(() => TargetLang.nameOf('zh-CN', currentUILang));
    await expect(row(page, entry.id).locator('.glossary-chip')).toHaveText(['example.com', zhName]);
    await expect(page.locator('#glossaryUsage')).toContainText('· 1 / 300');
  });

  test('card: editing an entry into another entry\'s source is refused under the form and stores nothing', async ({ page, context, extensionId }) => {
    await openGlossaryCard(page, extensionId);
    await addGlossaryEntryInCard(page, context, { s: 'GPU', t: '图形处理器' });
    const b = await addGlossaryEntryInCard(page, context, { s: 'CPU', t: '中央处理器' });
    const before = await syncSnapshot(context);

    await row(page, b.id).locator('.glossary-edit').click();
    const editor = page.locator('.glossary-editor');
    await editor.locator('#glossary-source').fill('GPU');
    await editor.locator('.glossary-save').click();
    await expect(editor.locator('.glossary-form-error'))
      .toHaveText('已经有一条相同的词条（原文、站点、目标语言都一样）。');
    // 表单不收，按钮可以再点；存储一个字节都没动。
    await expect(editor).toHaveCount(1);
    await expect(editor.locator('.glossary-save')).toBeEnabled();
    expect(await syncSnapshot(context)).toEqual(before);
    await centre(page, '.glossary-editor');
    report('card duplicate layout', await expectLaidOut(page,
      ['.glossary-form-error', '.glossary-save', '.glossary-cancel'], 'card duplicate'));

    await editor.locator('.glossary-cancel').click();
    await expect(editor).toHaveCount(0);
    await expect(row(page, b.id).locator('.glossary-source')).toHaveText('CPU');
    expect(await syncSnapshot(context)).toEqual(before);
  });

  test('card: a site that normalizes to nothing is refused under the form, never widened to every site', async ({ page, context, extensionId }) => {
    await openGlossaryCard(page, extensionId);
    const before = await syncSnapshot(context);

    await page.click('#glossaryAdd');
    const editor = page.locator('.glossary-editor');
    await editor.locator('#glossary-source').fill('attention');
    await editor.locator('#glossary-target').fill('注意力');
    // 写了站点，规范化后什么都不剩：失焦不能把它清成空（空站点就是「所有网站」）。
    await editor.locator('#glossary-site').fill('...');
    await editor.locator('#glossary-target').focus();
    await expect(editor.locator('#glossary-site')).toHaveValue('...');
    await editor.locator('.glossary-save').click();
    // 和 CSV 导入同一条规则（Glossary.validateEntry）拒收，说在表单下面。
    await expect(editor.locator('.glossary-form-error'))
      .toHaveText('这一条不合法：原文 1–80 字、译文至多 160 字，站点要是一个主机名。');
    await expect(editor).toHaveCount(1);
    await expect(editor.locator('.glossary-save')).toBeEnabled();
    expect(await syncSnapshot(context)).toEqual(before);
  });

  test('card: HTML in an entry is shown as literal text and creates no element', async ({ page, context, extensionId }) => {
    await openGlossaryCard(page, extensionId);
    const source = '<img src=x onerror="void 0">';
    const target = '<b>x</b>';
    const entry = await addGlossaryEntryInCard(page, context, { s: source, t: target });
    expect(entry.stored).toEqual({ s: source, t: target, l: '*', u: expect.any(Number) });

    const line = row(page, entry.id);
    await expect(line.locator('.glossary-source')).toHaveText(source);
    await expect(line.locator('.glossary-target')).toHaveText(target);
    await expect(line.locator('img, b')).toHaveCount(0);
  });

  test('card: switching the interface language redraws the card in the new language', async ({ page, context, extensionId }) => {
    await openGlossaryCard(page, extensionId);
    const entry = await addGlossaryEntryInCard(page, context, { s: 'attention', t: '注意力' });
    const line = row(page, entry.id);
    await expect(line.locator('.glossary-edit')).toHaveText('编辑');
    await expect(line.locator('.glossary-delete')).toHaveText('删除');

    // 这一行是运行时画的，身上没有 data-i18n：换界面语言要由卡片自己重画。
    await page.selectOption('#uiLanguage', 'en');
    await expect(line.locator('.glossary-edit')).toHaveText('Edit');
    await expect(line.locator('.glossary-delete')).toHaveText('Delete');
  });

  test('card: a CSV over the shared 1 MiB import cap is refused unread as over budget', async ({ page, context, extensionId }) => {
    await openGlossaryCard(page, extensionId);
    const before = await syncSnapshot(context);
    // 内容本身完全合法（一条词条加一串空行）：拒收只能来自文件大小这一道闸。
    const valid = `${HEADER}\r\nbig,大,0,,*\r\n`;
    const text = valid + '\r\n'.repeat(Math.ceil((1024 * 1024 + 1 - valid.length) / 2) + 16);
    expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(1024 * 1024);

    await importCsv(page, text, 'blab-glossary-huge.csv');
    await expect(page.locator('#glossaryError')).toHaveText('术语表已满（至多 300 条、32 KiB），请先删掉一些再加。');
    await expect(page.locator('#glossaryPreview')).toBeHidden();
    expect(await syncSnapshot(context)).toEqual(before);
  });
});
