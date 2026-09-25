// Blab Translation — 扩展页面对所有标签页的两种广播。
//
// 设置页和首装引导页都要在改完设置之后告诉已经开着的页面，也都可能刚下完一个
// 语言包。两页各写一份的话，消息形状迟早分叉（内容脚本只认一种），所以放在这
// 里，两页都按名字调用。
//
// 普通脚本，挂在 globalThis 上；页面按顺序加载，不用模块系统。
(function (root) {
  'use strict';

  // 没有内容脚本的标签页（chrome://、商店页、刚打开还没注入的）会 reject。广播
  // 是附带动作：一个标签页收不到，不该拦住别的，也没有谁能对这个错误做什么。
  // 连标签页都列不出来就是真故障了，但设置已经存下，广播失败不该让保存看起来
  // 失败 —— 在这一层接住，打一次日志。
  async function sendToAllTabs(message) {
    let tabs;
    try {
      tabs = await root.chrome.tabs.query({});
    } catch (error) {
      console.warn(`Blab Translation: could not broadcast ${message.type}`, error);
      return;
    }
    for (const tab of tabs) {
      root.chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  }

  /**
   * 设置变了。`settings` 可以只是改动的那几个键：内容脚本做的是
   * Object.assign(settings, message.settings)。
   */
  function settingsUpdated(settings) {
    return sendToAllTabs({ type: 'SETTINGS_UPDATED', settings });
  }

  /**
   * 一个语言包刚落地。
   *
   * 在它之前打开的标签页多半停在 ERROR：自动那一轮没有用户手势，传的是
   * `allowDownload: false`，每一批都回 `builtinNeedsDownload`。调度器不会自己重
   * 试 —— 对一个明摆着坏掉的引擎反复重试，正是烧掉用户额度的那条路 —— 所以没有
   * 这条消息，那些页面要一直空着直到刷新。
   *
   * 内容脚本对自己下完的包有同样的通知（ctx.onLanguagePackReady，
   * content/content-language-pack.js）；这里是它够不着的那一半：下载是在扩展页面
   * 里跑完的。接收端只在那个标签页确实用内置引擎时才理会，拿语言对和自己手上的
   * 比（源语言由调用方给：扩展页面下的是 LanguagePack.PROBE_SOURCE 那一对）。
   */
  function languagePackReady(sourceLang, targetLang) {
    return sendToAllTabs({ type: 'LANGUAGE_PACK_READY', sourceLang, targetLang });
  }

  root.TabBroadcast = { settingsUpdated, languagePackReady };
})(globalThis);
