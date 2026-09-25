// Blab Translation — 首装那一刻要做的事：打开引导页。
//
// 只认 reason === 'install'。更新（'update'）和 Chrome 自己升级
// （'chrome_update'）都不开：老用户已经配置过，每次发版弹一个欢迎页是打扰。
// 单独成文件，是为了在 node 里用假的 chrome 做单测，不必加载整个 background.js。

export const ONBOARDING_PATH = 'onboarding/onboarding.html';

/**
 * @param {chrome.runtime.InstalledDetails} details onInstalled 给的参数
 * @returns {Promise<chrome.tabs.Tab>|undefined} 开了标签页时是它的 promise；失败就 reject
 */
export function openOnboardingOnInstall(details) {
  if (!details || details.reason !== 'install') return undefined;
  return chrome.tabs.create({ url: chrome.runtime.getURL(ONBOARDING_PATH) });
}
