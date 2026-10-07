// Glossary fixtures and card steps for the glossary specs (moved out of
// helpers.js, which had reached its line budget).
const { expect } = require('@playwright/test');
const { getSyncSettings, syncSnapshot } = require('./helpers');

/**
 * 加一条术语表词条：从设置页发 GLOSSARY_WRITE（生产写入路径，经服务工作者的
 * 单写者队列落到 storage.sync），核对回话和存下的那一整条，再在设置页里按设计
 * 的算法量一次用量（Glossary.usage(Glossary.collect(整个 sync))）。
 *
 * 只用来铺设前置数据：C-J3、C-J8 把加词条标成 [fixture]（设计 §6.1 夹具隔离子
 * 步骤），走这条消息路径；C-J1 / C-J2 / C-J5 的加词条已改走设置页卡片
 * （addGlossaryEntryInCard）。
 * @returns {Promise<{id: string, usage: {count: number, bytes: number, max: number}, stored: object}>}
 */
async function addGlossaryEntry(context, extensionId, entry) {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options/options.html`);
  const reply = await options.evaluate(
    (e) => chrome.runtime.sendMessage({ type: 'GLOSSARY_WRITE', kind: 'put', entry: e }),
    entry,
  );
  const usage = await options.evaluate(async () => ({
    ...Glossary.usage(Glossary.collect(await chrome.storage.sync.get(null))),
    max: Glossary.LIMITS.maxItems,
  }));
  await options.close();
  expect(reply.value).toEqual({ id: expect.any(String), replaced: false });
  const key = `glossary:${reply.value.id}`;
  const stored = (await getSyncSettings(context, [key]))[key];
  // 存下的是整条：没给范围就是所有语言（l: '*'），写入时戳上 u。
  expect(stored).toEqual({ l: '*', ...entry, u: expect.any(Number) });
  return { id: reply.value.id, usage, stored };
}

/** sync 里全部术语表词条，按键：{ 'glossary:<id>': 存下的那一条 }。 */
async function storedGlossary(context) {
  const { items } = await syncSnapshot(context);
  return Object.fromEntries(Object.entries(items).filter(([key]) => key.startsWith('glossary:')));
}

/**
 * 打开设置页，等术语表卡片第一次读回存储（用量那一行有了字）。
 * @returns {Promise<import('@playwright/test').Page>}
 */
async function openGlossaryCard(page, extensionId) {
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await expect(page.locator('#glossaryUsage')).not.toHaveText('');
  return page;
}

/**
 * 在设置页的术语表卡片上加一条：点「添加词条」，逐项填表（原文、译文、区分
 * 大小写、站点、目标语言），点「保存」，等表单收起、存储里多出恰好一条新键。
 * 这是 C-J1 / C-J2 / C-J5 加词条的真实入口；只有铺设用的 addGlossaryEntry 走消息。
 * @param {import('@playwright/test').Page} options 已由 openGlossaryCard 打开的设置页
 * @param {{s: string, t?: string, c?: number, h?: string, l?: string}} entry
 * @returns {Promise<{id: string, stored: object}>}
 */
async function addGlossaryEntryInCard(options, context, entry) {
  const before = await storedGlossary(context);
  await options.click('#glossaryAdd');
  const editor = options.locator('.glossary-editor');
  await editor.locator('#glossary-source').fill(entry.s);
  await editor.locator('#glossary-target').fill(entry.t || '');
  // 原文含大写字母时表单会自动勾上「区分大小写」：按词条显式设一次。
  await editor.locator('#glossary-case').setChecked(Boolean(entry.c));
  await editor.locator('#glossary-site').fill(entry.h || '');
  await editor.locator('#glossary-lang').selectOption(entry.l || '*');
  await editor.locator('.glossary-save').click();
  await expect(editor).toHaveCount(0);
  let added = [];
  await expect.poll(async () => {
    added = Object.entries(await storedGlossary(context)).filter(([key]) => !(key in before));
    return added.length;
  }).toBe(1);
  const [key, stored] = added[0];
  return { id: key.slice('glossary:'.length), stored };
}

module.exports = { addGlossaryEntry, storedGlossary, openGlossaryCard, addGlossaryEntryInCard };
