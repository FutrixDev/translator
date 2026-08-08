const { test, expect } = require('./fixtures');
const { setExtensionSettings, getSyncSetting } = require('./helpers');

async function openOptions(page, extensionId, settings) {
  await setExtensionSettings(page, {
    targetLang: 'en',
    targetLangSetByUser: true,
    apiKey: 'sk-test',
    ...settings
  });
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await expect(page.locator('#modelSelect')).toBeVisible();
}

/**
 * The dropdown and the free-text box are two controls bound to one setting, and
 * only one of them can win. Picking from the list already clears the box; the
 * reverse has to hold too, or the page shows a model that is not the one being
 * used — the dropdown still displaying the old pick while the request goes out
 * with the typed name.
 */
test('typing a custom model overrides a model picked from the dropdown', async ({ page, context, extensionId }) => {
  await openOptions(page, extensionId, {
    provider: 'openrouter',
    apiEndpoint: 'https://openrouter.ai/api/v1/chat/completions',
    modelName: ''
  });

  await page.locator('#modelSelect').selectOption('anthropic/claude-opus-5');
  await expect.poll(() => getSyncSetting(context, 'modelName')).toBe('anthropic/claude-opus-5');

  await page.locator('#modelName').fill('x-ai/grok-4');
  await page.locator('#modelName').blur();

  // The typed name is what gets used...
  await expect.poll(() => getSyncSetting(context, 'modelName')).toBe('x-ai/grok-4');
  // ...so the dropdown must not keep advertising the model it replaced.
  await expect(page.locator('#modelSelect')).toHaveValue('');
});

test('clearing the custom model falls back to the dropdown selection', async ({ page, context, extensionId }) => {
  await openOptions(page, extensionId, {
    provider: 'openrouter',
    apiEndpoint: 'https://openrouter.ai/api/v1/chat/completions',
    modelName: 'x-ai/grok-4'
  });

  // A custom name that is not in the list loads into the text box.
  await expect(page.locator('#modelName')).toHaveValue('x-ai/grok-4');
  await expect(page.locator('#modelSelect')).toHaveValue('');

  await page.locator('#modelSelect').selectOption('openai/gpt-5.6-luna');
  await expect(page.locator('#modelName')).toHaveValue('');
  await expect.poll(() => getSyncSetting(context, 'modelName')).toBe('openai/gpt-5.6-luna');
});

test('a custom model survives a reload', async ({ page, context, extensionId }) => {
  await openOptions(page, extensionId, {
    provider: 'openrouter',
    apiEndpoint: 'https://openrouter.ai/api/v1/chat/completions',
    modelName: ''
  });

  await page.locator('#modelSelect').selectOption('anthropic/claude-opus-5');
  await page.locator('#modelName').fill('x-ai/grok-4');
  await page.locator('#modelName').blur();
  await expect.poll(() => getSyncSetting(context, 'modelName')).toBe('x-ai/grok-4');

  await page.reload();
  await expect(page.locator('#modelName')).toHaveValue('x-ai/grok-4');
  await expect(page.locator('#modelSelect')).toHaveValue('');
});
