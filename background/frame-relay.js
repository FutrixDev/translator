// 整页翻译进 iframe：子 frame 与顶层之间的中继。
//
// 子 frame 与顶层常常跨源，内容脚本之间没有直达的扩展消息通道 ——
// chrome.runtime.sendMessage 只到扩展页和服务工作者，tabs.sendMessage 只有这边
// 能发。所以两边的每一句话都从这里转一手。
//
// **这里没有状态**：服务工作者随时会被回收，登记表放在顶层文档里
// （content/frames/top.js）。这个监听只认 FRAME_* 消息，别的一律不回话、也不
// return true —— 那些归 background.js 的总分派，占着通道会让发信的一方等一个
// 永远不来的回话。
//
// 消息（发送方 → 这里 → 去向）：
//
//   FRAME_HELLO                子 frame → frame 0 的 FRAME_CHILD_HELLO；回话是顶层当前指令
//   FRAME_REPORT               子 frame → frame 0 的 FRAME_CHILD_REPORT
//   FRAME_BYE                  子 frame → frame 0 的 FRAME_CHILD_BYE
//   FRAME_DIRECTIVE_BROADCAST  顶层 → 这个标签页所有 frame 的 FRAME_DIRECTIVE
//   FRAME_ENGINE_REQUEST       子 frame → frame 0 的 FRAME_ENGINE_RELAY；回话是翻译结果

const TO_TOP = {
  FRAME_HELLO: 'FRAME_CHILD_HELLO',
  FRAME_REPORT: 'FRAME_CHILD_REPORT',
  FRAME_BYE: 'FRAME_CHILD_BYE',
};

// 「对面没有我们的监听」是这套协议里的正常情况，不是故障。实测（e2e 的
// frames.spec.js「relay semantics」）：tabs.sendMessage 没有接收方时 reject，文字
// 就是下面这一句；有监听但不回话时 resolve undefined，不报错。认 Chrome 报错原文
// 的只有这一个函数；每个用它的地方写明错过的那一句由哪一步补上。
export function isNoReceiver(error) {
  return /Receiving end does not exist/.test(String((error && error.message) || error));
}

// 顶层不在（还没起来、正在卸载、页面没有内容脚本）时回话是 null，由发信的一方补：
//   - FRAME_HELLO：子 frame 不登记，等顶层起来时 setup 的那一次广播再来 HELLO（top.js）；
//   - FRAME_REPORT / FRAME_BYE：顶层文档已经不在了，没有谁要这份汇报；
//   - FRAME_ENGINE_RELAY：子 frame 报「翻译失败」（child.js 的 requestTranslationViaTop）。
// 别的错记一条日志，回话同样是 null。
function sendToTop(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message, { frameId: 0 }).catch((error) => {
    if (!isNoReceiver(error)) console.warn('Blab Translation: frame relay to top failed', message.type, error);
    return null;
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message && message.type;
  if (typeof type !== 'string' || !type.startsWith('FRAME_')) return undefined;
  const tabId = sender.tab && sender.tab.id;
  if (typeof tabId !== 'number') return undefined;

  if (TO_TOP[type]) {
    const { type: _ignored, ...fields } = message;
    const relayed = sendToTop(tabId, {
      ...fields,
      type: TO_TOP[type],
      frameId: sender.frameId,
      documentId: sender.documentId || '',
    });
    if (type !== 'FRAME_HELLO') return undefined;
    relayed.then((directive) => sendResponse(directive || null));
    return true;
  }

  if (type === 'FRAME_DIRECTIVE_BROADCAST') {
    // 不带 frameId：发给这个标签页的每一个 frame。顶层自己也会收到，它不认这条。
    // 没有接收方 = 发广播的顶层文档自己也已经卸载：新文档的子 frame 向新的顶层 HELLO。
    chrome.tabs.sendMessage(tabId, { type: 'FRAME_DIRECTIVE', directive: message.directive })
      .catch((error) => {
        if (!isNoReceiver(error)) console.warn('Blab Translation: frame directive broadcast failed', error);
      });
    return undefined;
  }

  if (type === 'FRAME_ENGINE_REQUEST') {
    sendToTop(tabId, { type: 'FRAME_ENGINE_RELAY', message: message.message })
      .then((result) => sendResponse(result || null));
    return true;
  }

  return undefined;
});
