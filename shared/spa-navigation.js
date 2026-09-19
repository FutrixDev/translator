// Blab Translation — 单页应用的路由信号。
//
// 一次「导航」在单页应用里可以完全不经过浏览器：页面自己调 history.pushState，
// 换掉正文，地址栏变了，document 从头到尾是同一个。整页翻译、字幕、未来的面
// 都需要知道这件事发生了 —— 否则译文留在上一篇文章的位置上。
//
// **不能 monkeypatch history.pushState。** 内容脚本跑在 ISOLATED world：和页面
// 共享 DOM，但不共享 JS 全局与原型链。在这里改 History.prototype.pushState，
// 页面自己的调用走的是它那一份原型，改了等于没改。绕开它只有注入 MAIN world
// 脚本一条路，而 CLAUDE.md 明令不得把 YouTube 拦截器放宽到 <all_urls>，为路由
// 感知单开一个全站 MAIN world 脚本又要给每个页面多加一次注入。
//
// 所以三路并用，各补各的缺口：
//
//   popstate / hashchange  后退前进、锚点跳转。浏览器派发的事件，隔离世界收得到。
//   navigation             Navigation API 的 navigatesuccess，覆盖 pushState。
//                          Chrome 102+，且隔离世界里是否派发没有白纸黑字的保证 ——
//                          有就用，没有就当它不存在。
//   轮询                   兜底，前两者漏掉的一切。页面可见时每 800ms 比一次字符串。
//
// 三路读的都是同一个 location.href，而且都在导航落定之后读（navigate 事件在提交
// *之前* 派发，destination.url 可能最终没提交 —— 所以这里听的是 navigatesuccess）。
// 于是三路只是三个触发器，「现在的 URL 是什么」只有一个答案。
(function (root) {
  'use strict';

  const POLL_INTERVAL_MS = 800;

  const listeners = new Set();
  let wired = false;
  let pollTimer = null;
  let onWindowEvent = null;
  // 解绑要用绑定时的那个对象，而不是解绑那一刻再去 root 上取一次：页面走到一半
  // 时 root.navigation / root.document 还在不在，不是这个模块该赌的事。
  let navigationTarget = null;
  let onNavigationSuccess = null;
  let documentTarget = null;
  let onVisibilityChange = null;

  // 已经播报过的 URL。去重就靠它：三路对同一次导航各喊一声，只有第一声与它不同。
  //
  // 刻意不用「250ms 内同一个 to 只发一次」的时间窗：轮询可能在 popstate 之后
  // 800ms 才看见同一次导航，时间窗拦不住；而真有人在 250ms 内从 A 跳到 B 再跳
  // 回 A（锚点密集的文档页上是一次普通操作），时间窗会把第二次真导航吃掉。
  // 按「上次播报的 URL」去重两头都对。
  let lastUrl = '';

  function currentUrl() {
    const location = root.location;
    return location && typeof location.href === 'string' ? location.href : '';
  }

  function announce(via) {
    const to = currentUrl();
    if (!to || to === lastUrl) return;
    const from = lastUrl;
    lastUrl = to;
    // 复制一份再遍历：回调里退订是正常用法（「这一页我不管了」）。
    for (const listener of [...listeners]) {
      try {
        listener({ from, to, via });
      } catch (error) {
        console.error('Blab Translation: route change listener failed', error);
      }
    }
  }

  function isVisible() {
    const doc = root.document;
    return !doc || doc.visibilityState !== 'hidden';
  }

  function startPolling() {
    if (pollTimer !== null || !isVisible()) return;
    pollTimer = setInterval(() => announce('poll'), POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollTimer === null) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  function wire() {
    if (wired) return;
    wired = true;
    // 从此刻的 URL 起算。订阅之前发生过什么不是这个订阅者的事，补播一次
    // 陈年导航只会让上层白翻一遍。
    lastUrl = currentUrl();

    // via 报事件自己的名字：popstate 和 hashchange 是一路（都是浏览器派发的、
    // 隔离世界收得到的事件），但排障时「哪一种」是有用的信息。
    onWindowEvent = (event) => announce(event && event.type ? event.type : 'popstate');
    root.addEventListener('popstate', onWindowEvent);
    root.addEventListener('hashchange', onWindowEvent);

    const navigation = root.navigation;
    if (navigation && typeof navigation.addEventListener === 'function') {
      navigationTarget = navigation;
      onNavigationSuccess = () => announce('navigation');
      navigationTarget.addEventListener('navigatesuccess', onNavigationSuccess);
    }

    const doc = root.document;
    if (doc && typeof doc.addEventListener === 'function') {
      onVisibilityChange = () => {
        if (isVisible()) {
          // 先补一次：隐藏期间的导航轮询没看见，等下一个 800ms 就迟了。
          announce('poll');
          startPolling();
        } else {
          stopPolling();
        }
      };
      documentTarget = doc;
      documentTarget.addEventListener('visibilitychange', onVisibilityChange);
    }

    startPolling();
  }

  function unwire() {
    if (!wired) return;
    wired = false;
    stopPolling();
    root.removeEventListener('popstate', onWindowEvent);
    root.removeEventListener('hashchange', onWindowEvent);
    onWindowEvent = null;
    if (navigationTarget) {
      navigationTarget.removeEventListener('navigatesuccess', onNavigationSuccess);
      navigationTarget = null;
      onNavigationSuccess = null;
    }
    if (documentTarget) {
      documentTarget.removeEventListener('visibilitychange', onVisibilityChange);
      documentTarget = null;
      onVisibilityChange = null;
    }
    lastUrl = '';
  }

  /**
   * 订阅路由变化。回调收到 { from, to, via }，via 是三路里先看见的那一路
   * （'popstate' | 'hashchange' | 'navigation' | 'poll'），只作排障用。
   * 返回退订函数；最后一个订阅者退订后监听与轮询一并撤掉，空转的页面上这个
   * 模块不该有心跳。
   */
  function onRouteChange(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    wire();
    return function unsubscribe() {
      if (!listeners.delete(listener)) return;
      if (listeners.size === 0) unwire();
    };
  }

  root.SpaNavigation = { POLL_INTERVAL_MS, currentUrl, onRouteChange };
})(globalThis);
