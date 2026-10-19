// Two ways the first minutes with the extension used to dead-end in the popup.
//
// 1. A tab opened before the extension was installed or updated has no content
//    script: Chrome injects into pages that load after it, never into the ones
//    already open. The popup said "Blab can't run on this page" there — the
//    same sentence as chrome:// — when a reload is the whole fix.
//
// 2. Chrome gives the suggested keys only on a fresh install, and never one
//    another extension already holds, so "Translate this page" can arrive with
//    no shortcut. The popup then offers to set one.
const { test, expect } = require('./fixtures');
const { getMessage } = require('../../i18n/messages');
const { openPopupOver } = require('./helpers');

const en = (key) => getMessage(key, 'en');
const SITE = 'https://before-install.example.test';
const PAGE = '<!doctype html><html lang="fr"><body><p>Le chat dort sur le canapé.</p></body></html>';

test('a tab opened before the install asks for a reload, and the reload brings Blab in', async ({ page, context, extensionId }) => {
  await context.route(`${SITE}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: PAGE }));
  await page.goto(`${SITE}/`);
  await page.waitForSelector('#ai-translator-float-ball');

  // Such a tab answers the popup the way Chrome answers for any tab with no
  // content script, until it reloads. (chrome.runtime.reload() would make the
  // real one, but in the headless shell a command-line extension does not come
  // back from it.)
  const popup = await openPopupOver(context, extensionId, page, (site) => {
    let reloaded = false;
    chrome.tabs.onUpdated.addListener((_id, change, tab) => {
      if (change.status === 'complete' && tab.url && tab.url.startsWith(site)) reloaded = true;
    });
    const send = chrome.tabs.sendMessage.bind(chrome.tabs);
    chrome.tabs.sendMessage = (...args) => (reloaded ? send(...args)
      : Promise.reject(new Error('Could not establish connection. Receiving end does not exist.')));
  }, SITE);
  await expect(popup.locator('#statusText')).toHaveText(en('statusPageNeedsReload'));
  await expect(popup.locator('#reloadPage')).toHaveText(en('reloadPage'));
  await expect(popup.locator('#reloadPage')).toBeVisible();
  // "Translate this page" says the same thing instead of "translation failed".
  await popup.locator('#translatePage').click();
  await expect(popup.locator('#statusText')).toHaveText(en('statusPageNeedsReload'));

  const reloaded = page.waitForEvent('load');
  await popup.locator('#reloadPage').click();
  await reloaded;
  await expect(popup.locator('#reloadPage')).toBeHidden();
  await expect(popup.locator('#statusText')).not.toHaveText(en('statusPageNeedsReload'));
  await expect(popup.locator('#statusText')).not.toHaveText(en('statusPageUnsupported'));
  // What is left is the engine's own state, from the page that now answers.
  await expect(popup.locator('#statusText')).toHaveText(en('apiNotConfigured'));
});

test('a page no extension may run on stays unsupported, with no reload to offer', async ({ page, context, extensionId }) => {
  await page.goto('about:blank');
  const popup = await openPopupOver(context, extensionId, page);
  await expect(popup.locator('#statusText')).toHaveText(en('statusPageUnsupported'));
  await expect(popup.locator('#reloadPage')).toBeHidden();
});

test('"Translate this page" with no shortcut offers to set one', async ({ page, context, extensionId }) => {
  await page.goto('about:blank');
  // Keys assigned (a fresh install with nothing in the way): no offer.
  const assigned = await openPopupOver(context, extensionId, page);
  await expect(assigned.locator('#translatePageShortcut')).toBeVisible();
  await expect(assigned.locator('#setShortcut')).toBeHidden();
  await assigned.close();

  // Chrome gave this command no key.
  const popup = await openPopupOver(context, extensionId, page, () => {
    const getAll = chrome.commands.getAll.bind(chrome.commands);
    chrome.commands.getAll = async () => (await getAll()).map((command) =>
      command.name === 'toggle-translate-page' ? { ...command, shortcut: '' } : command);
  });
  await expect(popup.locator('#translatePageShortcut')).toBeHidden();
  await expect(popup.locator('#setShortcut')).toHaveText(en('setShortcut'));
  const opened = context.waitForEvent('page');
  await popup.locator('#setShortcut').click();
  expect((await opened).url()).toBe('chrome://extensions/shortcuts');
});
