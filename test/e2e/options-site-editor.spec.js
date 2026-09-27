// R33 A2：设置页的站点编辑器（options/options-site-editor.js）。
//
// 从前「你表过态的网站」只能忘掉一条；要开一个站点，得先去那个站点上点 popup。
// 这一份走的是设置页自己那条路：敲一个地址进去、选「总是」，那个站点开着的标签
// 页当场开译 —— 写的是 decide() 查的那张表，键由 SiteRules.parseSiteInput 生成。
// 再加上敲错时的那句话、always↔never、忘掉，以及只读的内置名单上一键盖过去。
const { test, expect } = require('./fixtures');
const { getMessage } = require('../../i18n/messages');
const { getSyncSetting } = require('./helpers');
const { startMockOpenAIServer } = require('./mock-openai-server');
const { expectLaidOut } = require('./layout-checks');
const { BODY, serve } = require('./auto-touchpoint-fixtures');

const en = (key) => getMessage(key, 'en');

async function openOptions(context, extensionId) {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options/options.html`);
  await options.waitForSelector('#siteRuleAdd');
  return options;
}

async function addSite(options, text, state = 'always') {
  await options.fill('#siteRuleInput', text);
  await options.selectOption('#siteRuleState', state);
  await options.click('#siteRuleAddButton');
}

test('adding a site in Settings makes that page translate by itself, without a reload', async ({ page, context, extensionId }) => {
  const { close, endpoint, sentTexts } = await startMockOpenAIServer();
  try {
    await serve(page, context, endpoint);
    // 名单外的站点：安静地不翻。
    await page.waitForTimeout(1500);
    await expect(page.locator('#box .ai-translator-inline-block')).toHaveCount(0);
    expect(sentTexts.join('\n')).not.toContain(BODY);

    const options = await openOptions(context, extensionId);
    await options.locator('#siteRuleAdd').evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await expectLaidOut(options, ['#siteRuleInput', '#siteRuleState', '#siteRuleAddButton'], 'site editor');

    // 贴整条地址：协议、www.、路径都脱掉，存的是 decide() 查的那把键。
    await addSite(options, 'https://www.ASK.test/ledger?from=options');
    await expect.poll(() => getSyncSetting(context, 'siteRules'), { timeout: 5000 }).toEqual({ 'ask.test': 'always' });
    await expect(options.locator('#siteRules .site-rule-host')).toHaveText(['ask.test']);
    await expect(options.locator('#siteRuleInput')).toHaveValue('');
    await expect(options.locator('#siteRuleError')).toBeHidden();

    // 那一页没刷新就开译了。
    await page.bringToFront();
    await page.waitForSelector('#box .ai-translator-inline-block', { timeout: 30000 });
    await expect(page.locator('#box .ai-translator-inline-block')).toContainText(BODY);
    await options.close();
  } finally {
    await close();
  }
});

test('Settings site editor: bad input is named inline, a row switches and forgets', async ({ page, context, extensionId }) => {
  const options = await openOptions(context, extensionId);
  await expect(options.locator('#siteRules .site-rules-empty')).toHaveText(en('siteRulesEmpty'));

  await addSite(options, 'not a site');
  await expect(options.locator('#siteRuleError')).toHaveText(en('siteRuleInputInvalid'));
  await expect(options.locator('#siteRuleInput')).toHaveAttribute('aria-invalid', 'true');
  // 黑名单上的站点：写什么都不算数，说清楚为什么。
  await addSite(options, 'https://mail.google.com/mail/u/0');
  await expect(options.locator('#siteRuleError'))
    .toHaveText(en('siteRuleInputBlocked').replace('{site}', 'mail.google.com'));
  expect(await getSyncSetting(context, 'siteRules')).toBeFalsy();
  // 一改输入，那句话就收起来。
  await options.fill('#siteRuleInput', 'forum.example');
  await expect(options.locator('#siteRuleError')).toBeHidden();

  await addSite(options, 'forum.example', 'never');
  await expect.poll(() => getSyncSetting(context, 'siteRules')).toEqual({ 'forum.example': 'never' });

  const row = options.locator('#siteRules .site-rule[data-host="forum.example"]');
  await row.locator('select').selectOption('always');
  await expect.poll(() => getSyncSetting(context, 'siteRules')).toEqual({ 'forum.example': 'always' });
  await expect(row.locator('select')).toHaveValue('always');

  await row.locator('.site-rule-forget').click();
  await expect.poll(() => getSyncSetting(context, 'siteRules')).toEqual({});
  await expect(options.locator('#siteRules .site-rules-empty')).toBeVisible();
  await options.close();
});

test('Settings built-in lists are read-only and one click overrides an entry', async ({ context, extensionId }) => {
  const options = await openOptions(context, extensionId);
  const builtin = options.locator('#siteRulesBuiltin');
  const always = builtin.locator('details[data-state="always"]');
  const captions = builtin.locator('details[data-state="captions"]');
  const never = builtin.locator('details[data-state="never"]');

  // 折着的：三组标题看得见，行看不见。
  await expect(always.locator('.site-rule[data-host="x.com"]')).toBeHidden();
  await always.locator('summary').click();
  const x = always.locator('.site-rule[data-host="x.com"]');
  await expect(x).toBeVisible();

  // never 那一组没有按钮：阶梯上它排在用户规则前面，盖不过。
  await never.locator('summary').click();
  await expect(never.locator('.site-rule[data-host="mail.google.com"]')).toBeVisible();
  await expect(never.locator('button')).toHaveCount(0);

  await x.locator('.site-rule-override').click();
  await expect.poll(() => getSyncSetting(context, 'siteRules')).toEqual({ 'x.com': 'never' });
  // 盖过去以后：这一行说「按你的规则」，你的规则那一栏多了一行，展开着的组没被合上。
  await expect(x).toContainText(en('siteRuleOverridden'));
  await expect(x.locator('.site-rule-override')).toHaveCount(0);
  await expect(options.locator('#siteRules .site-rule-host')).toHaveText(['x.com']);

  // 字幕站：一键「连页面一起翻」写的是 always。
  await captions.locator('summary').click();
  await captions.locator('.site-rule[data-host="youtube.com"] .site-rule-override').click();
  await expect.poll(() => getSyncSetting(context, 'siteRules')).toEqual({ 'x.com': 'never', 'youtube.com': 'always' });
  await options.close();
});
