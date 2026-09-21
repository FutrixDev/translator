/**
 * 自动翻译触点 e2e 的共用夹具：一个我们拿不准的站点、一段不像任何语言样本的正文、
 * 以及「装好设置、把这个站点接上、等悬浮球出来」这三步。
 *
 * 用它的三份 spec：auto-translate-touchpoints.spec.js（问与开关）、
 * auto-translate-hidden.spec.js（藏起译文那条路）、
 * auto-translate-hotkey.spec.js（键位相撞）。
 */
const { setExtensionSettings } = require('./helpers');

const ORIGIN = 'https://ask.test';
const BODY = 'The harbour master keeps a separate ledger for the boats that never came back.';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Harbour ledger</title></head>
<body><div id="box"><p id="para">${BODY}</p></div></body></html>`;

async function serve(page, context, endpoint, extra = {}) {
  await setExtensionSettings(page, {
    apiEndpoint: endpoint,
    apiKey: 'test-key',
    modelName: 'gpt-4.1-mini',
    targetLang: 'zh-CN',
    skipTargetLanguageText: false,
    ...extra
  });
  await context.route(`${ORIGIN}/**`, (route) => {
    route.fulfill({ status: 200, contentType: 'text/html', body: PAGE });
  });
  await page.goto(`${ORIGIN}/ledger`);
  await page.waitForSelector('#ai-translator-float-ball');
}

module.exports = { ORIGIN, BODY, PAGE, serve };
