// Blab Translation — 一次自动翻译会话的身份与作废。
//
// 自动翻译和用户点一次「翻译整页」的区别，全在时间上：请求发出去之后，页面还在
// 动。等译文回来的那一两秒里，用户可能已经翻到了下一条路由，虚拟列表可能已经把
// 那个节点回收去装别的推文，用户可能刚换了目标语言。把这时候回来的译文写上去，
// 轻则 A 块挂上 B 块的译文，重则上一篇文章的译文出现在这一篇里。
//
// 这个模块回答三个问题，合在一起就是「这条译文还该不该写」：
//
//   代次   这次请求属于哪一轮。换路由、换语言、换引擎、用户还原或暂停，都让
//          代次加一，之前所有在途请求一律作废。
//   身份   这个块是谁。**只做记账**（队列、日志），不是幂等依据 —— 幂等依据是
//          文本指纹，见 shared/block-identity.js。虚拟列表里 DOM path 恰恰是
//          稳定的，拿它当身份会把「节点被回收」这件事整个掩盖掉。
//   指纹   发请求那一刻这个块的文字。回来时对不上，说明节点被回收了。
//
// **不取消请求。** chrome.runtime.sendMessage 没有可靠的取消，而且请求已经发出
// 去、钱已经花了。作废只发生在写回之前 —— 那是唯一做得干净的层次。
//
// DOM 依赖靠注入（readText / fingerprint），所以这个模块在 node 里能整个跑起来：
// 传一组普通对象当元素即可。唯一直接读元素的字段是 isConnected，测试里要显式给。
(function (root) {
  'use strict';

  /**
   * @param {Object} deps
   * @param {(element: any) => string} deps.readText    读出这个块此刻的原文
   * @param {(text: string) => string} deps.fingerprint 文本 -> 指纹（BlockIdentity.fingerprint）
   */
  function create(deps) {
    const readText = deps && deps.readText;
    const fingerprint = deps && deps.fingerprint;
    if (typeof readText !== 'function' || typeof fingerprint !== 'function') {
      throw new TypeError('SessionGuard.create needs readText and fingerprint');
    }

    // 从 1 起而不是 0：0 是「没填过这个字段」的样子，两者混在一起时
    // `ticket.sessionVersion !== version` 会把没盖章的请求当成同代放行。
    let version = 1;
    let nextId = 1;
    const ids = new WeakMap();

    /**
     * 会话内自增整数。WeakMap 而不是往元素上写属性：页面的框架会克隆、序列化、
     * 比较它自己的节点，我们加的属性会跟着跑进它的逻辑里。
     */
    function blockId(element) {
      if (!element || typeof element !== 'object') return 0;
      let id = ids.get(element);
      if (id === undefined) {
        id = nextId++;
        ids.set(element, id);
      }
      return id;
    }

    /**
     * 发请求前盖一个章。指纹在这里算 —— 和 accept() 同一个入口，两边就不可能
     * 各归一化一套。
     */
    function stamp(element) {
      return {
        element,
        blockId: blockId(element),
        textFingerprint: fingerprint(readText(element)),
        sessionVersion: version
      };
    }

    /**
     * 写回前的三重校验，三条全过才算数。
     *
     * 顺序是按「多便宜」排的：连着没有是一个字段读取，代次是一次整数比较，
     * 指纹要把整棵子树的文字读一遍 —— 前两条能挡掉的绝大多数情况下，第三条
     * 根本不会跑。
     */
    function accept(ticket) {
      if (!ticket) return false;
      const element = ticket.element;
      // 节点已经不在文档里了。往游离节点上插译文不报错，只是永远没人看得见，
      // 而它拖着的那棵子树也就永远不会被回收。
      if (!element || !element.isConnected) return false;
      if (ticket.sessionVersion !== version) return false;
      return fingerprint(readText(element)) === ticket.textFingerprint;
    }

    /**
     * 代次加一。reason 只进日志 —— 「为什么作废」在排障时是最想知道的一件事，
     * 而事后从代次号上一点也看不出来。
     */
    function bump(reason) {
      version += 1;
      console.debug('Blab Translation: auto session ->', version, reason || 'unspecified');
      return version;
    }

    return {
      version: () => version,
      bump,
      blockId,
      stamp,
      accept
    };
  }

  root.SessionGuard = { create };
})(globalThis);
