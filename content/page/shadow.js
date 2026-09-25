// Blab Translation — 整页翻译：Shadow DOM
//
// 收块、显隐、发现层原来只看得见顶层文档的 light DOM：Web Components 站点把正文
// 放进 shadow root，那里的字一个都不翻。这个文件给那几处一套「组合树」工具：
//
// - 发现：open root 读 el.shadowRoot；closed root 只有扩展能拿到，
//   chrome.dom.openOrClosedShadowRoot 只问自定义元素（标签名含 `-`）——内置元素
//   挂 closed root 的只有浏览器自己（<input>、<video> 的控件），那里没有正文。
// - 登记表：发现过的 root 都记下来，可订阅（发现层据此给新 root 追加观察）；
//   取用时丢掉宿主已脱离文档的。
// - 组合子节点：宿主的子节点 = shadow 树 + 已分进 slot 的 light 子节点；<slot>
//   只在一个节点都没分进来时才算它的后备内容。每个渲染出来的节点恰好走到一次，
//   没渲染的（没分进 slot 的 light 子节点）一次都不走。
// - 样式：译文的样式表（content/css/translation.css）是注入文档的，进不了 shadow
//   树。只给**收到译文的** root 装一份，由 afterInsertTranslation 每次插入时复核。
//   只走 constructable stylesheet（adoptedStyleSheets），装不上就记一条日志，这个
//   root 没有样式，下一次插入再试。
//
// 普通页面上这些工具走的还是 el.children / el.childNodes 原物，遍历路径不变。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const roots = new Set();
  const listeners = new Set();

  function register(root) {
    if (!root || roots.has(root)) return;
    roots.add(root);
    for (const fn of [...listeners]) {
      try { fn(root); } catch (error) { console.warn('Blab Translation: shadow root listener failed', error); }
    }
  }

  // 扩展 API 只在内容脚本里有；e2e 的 DOM 夹具是普通页面，那里的 chrome 没有
  // dom / runtime.sendMessage，同 content-bootstrap.js 的写法软读。
  function extensionApi() {
    return typeof chrome !== 'undefined' ? chrome : null;
  }

  // closed root 只对自定义元素问。chrome.dom.openOrClosedShadowRoot 只收
  // HTMLElement，名字带 `-` 的 MathML / SVG 元素（<annotation-xml>、<font-face>）
  // 传进去会抛参数错误——它们也挂不了 shadow root，先按类型挡掉。
  function shadowRootOf(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
    let root = el.shadowRoot || null;
    if (!root && el.localName.includes('-') && el instanceof HTMLElement) {
      const dom = extensionApi()?.dom;
      if (dom) root = dom.openOrClosedShadowRoot(el) || null;
    }
    if (root) register(root);
    return root;
  }

  function composed(el, pick) {
    const root = shadowRootOf(el);
    if (root) {
      const out = Array.from(pick(root));
      for (const node of pick(el)) {
        if (node.assignedSlot) out.push(node);
      }
      return out;
    }
    if (el.localName === 'slot' && typeof el.assignedNodes === 'function') {
      return el.assignedNodes().length > 0 ? [] : pick(el);
    }
    return pick(el);
  }

  const elementsOf = (node) => node.children;
  const nodesOf = (node) => node.childNodes;

  // 组合树上的子元素 / 子节点。没有 shadow root、也不是 <slot> 时原样返回
  // el.children / el.childNodes（活集合），调用方的遍历和今天完全一样。
  function composedChildren(el) {
    return composed(el, elementsOf);
  }

  function composedChildNodes(el) {
    return composed(el, nodesOf);
  }

  // 组合树上的父元素。被分进 slot 的节点仍认 light 树里的父亲（宿主）——
  // 继承（notranslate、跳过规则）按作者写的结构走，不按渲染位置。
  function composedParent(el) {
    if (!el) return null;
    if (el.parentElement) return el.parentElement;
    const parent = el.parentNode;
    return parent && parent.nodeType === Node.DOCUMENT_FRAGMENT_NODE && parent.host ? parent.host : null;
  }

  // closest 撞到 shadow root 就从宿主接着找。
  function closestComposed(el, selector) {
    if (!selector) return null;
    let node = el;
    while (node) {
      const hit = node.closest(selector);
      if (hit) return hit;
      const root = node.getRootNode();
      node = root && root.host ? root.host : null;
    }
    return null;
  }

  function composedContains(ancestor, node) {
    for (let el = node; el; ) {
      if (ancestor.contains(el)) return true;
      const root = el.getRootNode();
      el = root && root.host ? root.host : null;
    }
    return false;
  }

  // 自定义元素和带 shadow root 的元素按容器处理（collect.js 的递归判定）。
  function isShadowContainer(el) {
    return !!el && el.nodeType === Node.ELEMENT_NODE &&
      (el.localName.includes('-') || !!shadowRootOf(el));
  }

  function shadowRoots() {
    const live = [];
    for (const root of roots) {
      if (root.host && root.host.isConnected) live.push(root);
      else roots.delete(root);
    }
    return live;
  }

  // 订阅新 root；返回退订函数。
  function onShadowRoot(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  // 文档 + 全部登记 root 里命中 selector 的元素，数组。
  function queryAllDeep(selector) {
    const out = Array.from(document.querySelectorAll(selector));
    for (const root of shadowRoots()) {
      for (const el of root.querySelectorAll(selector)) out.push(el);
    }
    return out;
  }

  // ---- 样式 ----

  let styleTextPromise = null;
  let sharedSheet = null;

  // 同时收到译文的几个 root 共用这一个在途请求。
  function loadStyleText() {
    if (!styleTextPromise) {
      const runtime = extensionApi()?.runtime;
      // e2e 的 DOM 夹具是普通页面，没有扩展运行时：没有样式可要。
      if (!runtime || !runtime.sendMessage) return Promise.resolve('');
      styleTextPromise = runtime.sendMessage({ type: 'GET_SHADOW_STYLES' })
        .then((reply) => reply.css)
        .catch((error) => {
          console.warn('Blab Translation: loading shadow styles failed', error);
          return '';
        });
      // 空文本不缓存：SW 这一次没拿到（它自己记过日志）或者上面失败了，下一次插入再问。
      styleTextPromise.then((css) => { if (!css) styleTextPromise = null; });
    }
    return styleTextPromise;
  }

  function hasStyle(root) {
    return !!sharedSheet && root.adoptedStyleSheets.includes(sharedSheet);
  }

  function installStyle(root, css) {
    if (!css || !root.host || !root.host.isConnected || hasStyle(root)) return;
    try {
      if (!sharedSheet) {
        // 先在局部建好：replaceSync 抛错时不留下一张空表，下一次还会重建。
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        sharedSheet = sheet;
      }
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sharedSheet];
    } catch (error) {
      // 这个 root 没有样式（译文照样在，只少了淡入与收起规则），下一次插入再试。
      console.warn('Blab Translation: installing shadow styles failed', error);
    }
  }

  // root 可能被站点整个重建（adoptedStyleSheets 被站点重新赋值），所以每次插入
  // 都复核，不靠「装过一次」的记账。
  function ensureShadowStyles(root) {
    if (hasStyle(root)) return;
    loadStyleText().then((css) => installStyle(root, css));
  }

  // batch.js 每插一块译文调一次（唯一的生产插入口）。
  function afterInsertTranslation(block) {
    const element = block && block.element;
    if (!element || !element.isConnected) return;
    const root = element.getRootNode();
    if (root && root.nodeType === Node.DOCUMENT_FRAGMENT_NODE && root.host) {
      register(root);
      ensureShadowStyles(root);
    }
    // 块本身被分进具名 slot、译文是它的兄弟：译文也得进同一个 slot，否则掉进默认
    // slot（或者宿主没有默认 slot，根本不渲染）。
    const slot = element.getAttribute('slot');
    if (slot === null) return;
    const entry = globalThis.BlockIdentity.lookup(element);
    const translationEl = entry && entry.translationEl;
    if (translationEl && translationEl.parentNode === element.parentNode &&
        translationEl.getAttribute('slot') !== slot) {
      translationEl.setAttribute('slot', slot);
    }
  }

  ctx.shadowRoots = shadowRoots;
  ctx.onShadowRoot = onShadowRoot;
  ctx.composedChildren = composedChildren;
  ctx.composedChildNodes = composedChildNodes;
  ctx.composedParent = composedParent;
  ctx.closestComposed = closestComposed;
  ctx.composedContains = composedContains;
  ctx.isShadowContainer = isShadowContainer;
  ctx.queryAllDeep = queryAllDeep;
  ctx.afterInsertTranslation = afterInsertTranslation;
})();
