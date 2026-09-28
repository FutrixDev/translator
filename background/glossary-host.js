// Blab Translation — 用户术语表：service worker 回给内容脚本的那一半
//
// 只做一件事：GLOSSARY_FOR_HOST。顶层帧（content/content-glossary.js）建词表镜像
// 时来要一次本主机的词条。主机取发信的那一帧的地址（sender.url），不信消息里
// 带来的；只有顶层帧发这条，所以它就是顶层页面的主机。回的是这个主机上生效的
// 全部词条（全局的加上站点匹配的），按目标语言挑胜者是页面自己的事。
//
// 消息监听只认这一条：别的消息既不回话也不 return true——回一个 undefined 会抢在
// 真正的处理者前面把通道关掉（同 custom-rules-host.js）。
//
// 词条的读与缓存在 shared/glossary.js（globalThis.Glossary），由入口 background.js
// 先 import；这里调用时才读，不依赖 import 次序。

export function handleMessage(message, sender, sendResponse) {
  if (!message || message.type !== 'GLOSSARY_FOR_HOST') return undefined;
  const { Glossary, SiteRules } = globalThis;
  Promise.resolve()
    .then(() => Glossary.cached())
    .then((entries) => sendResponse({
      entries: Glossary.forHost(entries, SiteRules.normalizeHost(new URL(sender.url).hostname)),
    }))
    .catch((error) => {
      console.error('GLOSSARY_FOR_HOST failed:', error);
      sendResponse({ error: error.message });
    });
  return true;
}

chrome.runtime.onMessage.addListener(handleMessage);
