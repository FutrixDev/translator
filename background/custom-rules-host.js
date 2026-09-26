// Blab Translation — 用户站点规则：service worker 回给内容脚本的那一半
//
// 只做一件事：CUSTOM_RULES_FOR_HOST。内容脚本（content/page/custom-rule.js）建本
// frame 的镜像时来要一次本主机的规则。主机取发信的那一帧的地址（sender.url），
// 不信消息里带来的：内容脚本的镜像按同一个主机建。回的是这个主机的全部规则，按
// 路径挑胜出的那条是页面自己的事。
//
// 消息监听只认这一条：别的消息既不回话也不 return true——回一个 undefined 会抢在
// 真正的处理者前面把通道关掉。
//
// 规则的读与缓存在 shared/custom-rules.js（globalThis.CustomRules），由入口
// background.js 先 import；这里调用时才读，不依赖 import 次序。

export function handleMessage(message, sender, sendResponse) {
  if (!message || message.type !== 'CUSTOM_RULES_FOR_HOST') return undefined;
  const CustomRules = globalThis.CustomRules;
  CustomRules.cached()
    .then((rules) => sendResponse({
      rules: CustomRules.forHost(rules, new URL(sender.url).hostname),
    }))
    .catch((error) => {
      console.error('CUSTOM_RULES_FOR_HOST failed:', error);
      sendResponse({ error: error.message });
    });
  return true;
}

chrome.runtime.onMessage.addListener(handleMessage);
