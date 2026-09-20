// Blab Translation Content Script Utilities
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  ctx.escapeHtml = function(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  };

  // ==================== 受管 DOM 容器 ====================

  // 富文本编辑器把自己的子树和内部 EditorState 对账：Lexical、ProseMirror、Slate
  // 等都挂着 MutationObserver，发现子树里出现了它不认识的节点，就按内部状态重建
  // 这一段 DOM —— 我们插进去的译文会在一帧之内被删掉。
  //
  // 后果不只是“看不到译文”：源块上的 ai-translator-inline-source 标记还留着，
  // 扩展认为这块已经翻过了，再次悬停也不会重试，于是表现为“悬停翻译完全没反应”。
  //
  // 关键是 contenteditable 判断挡不住这类容器。编辑器处于只读模式时属性是
  // contenteditable="false"，isContentEditable 为 false，照样会撤销外来节点
  // （Higgsfield 的文章正文 div.rde-content 就是这样：data-lexical-editor="true" +
  // contenteditable="false" + aria-readonly="true"）。
  //
  // 这里只收“框架托管但不可编辑”的情形。真正可编辑的输入面（contenteditable="true"、
  // input/textarea）是另一回事 —— 那种地方压根就不该翻译，由各调用方自己的
  // isContentEditable / isEditableTarget 判断先一步挡掉。
  const MANAGED_DOM_ROOT_SELECTOR = [
    '[data-lexical-editor]',   // Lexical (Meta)
    '.ProseMirror',            // ProseMirror / TipTap
    '[data-slate-editor]',     // Slate
    '.ql-editor',              // Quill
    '.cm-content',             // CodeMirror 6
    '.CodeMirror-code',        // CodeMirror 5
    '.monaco-editor'           // Monaco
  ].join(', ');

  // 选择器本身不导出：调用方问的都是“这个元素在不在受管容器里”，把名单递出去只会
  // 让别的文件各自 querySelectorAll 一遍，规则就从这里漏出去了。

  // 返回 element 所在的受管容器根节点，不在受管容器里则返回 null。
  ctx.getManagedDomRoot = function(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return null;
    if (typeof element.closest !== 'function') return null;
    return element.closest(MANAGED_DOM_ROOT_SELECTOR);
  };

  ctx.isInsideManagedDomRoot = function(element) {
    return !!ctx.getManagedDomRoot(element);
  };

  // ==================== 右键点到的那张图 ====================

  // A context-menu click reports `info.srcUrl`, and that is not enough to know
  // WHICH image the user meant: a page can show the same src a dozen times
  // (thumbnail grids, lazy-load placeholders). The click point is the only
  // unambiguous answer, and it is gone by the time the menu click arrives — so
  // it is recorded here, once, for every feature that acts on an image.
  //
  // One listener rather than one per feature: comic translation and image OCR
  // both need exactly this, and two listeners answering the same question is
  // how they drift apart.
  let lastContextImage = null;

  document.addEventListener('contextmenu', (event) => {
    // A synthetic contextmenu carries no cursor position, and letting one
    // through would throw away the target of the real right-click that follows.
    if (!event.isTrusted) return;
    lastContextImage = ctx.imageAtPoint(event.clientX, event.clientY);
  }, true);

  function naturalArea(img) {
    return (img.naturalWidth || 0) * (img.naturalHeight || 0);
  }

  /**
   * The image the user is pointing at — not necessarily the topmost one.
   *
   * Anti-copy sites stack a tiny transparent image over the artwork and stretch
   * it to the same box, so hit-testing lands on the decoy by design. Resolution
   * is what tells the real image apart from the thing covering it.
   */
  ctx.imageAtPoint = function(x, y) {
    if (typeof document.elementsFromPoint !== 'function') return null;
    const images = document.elementsFromPoint(x, y).filter(el => el.tagName === 'IMG');
    if (!images.length) return null;
    return images.reduce((best, img) => (naturalArea(img) > naturalArea(best) ? img : best));
  };

  /** The last right-clicked image, or null if it is gone from the document. */
  ctx.getLastContextImage = function() {
    return lastContextImage && lastContextImage.isConnected ? lastContextImage : null;
  };

  /** How much of the screen an image takes up — the "is this the big one" test. */
  ctx.renderedArea = function(img) {
    const rect = img.getBoundingClientRect();
    return rect.width * rect.height;
  };

  /**
   * Does this element show the src the context menu reported?
   *
   * `currentSrc` as well as `src`, because a responsive image serves neither
   * one reliably: the menu reports whichever the browser actually loaded.
   * Features with extra ways to recognise their own images (comic translation
   * stamps the ones it swaps) build on top of this rather than restating it.
   */
  ctx.imageMatchesSrc = function(img, srcUrl) {
    if (!srcUrl) return false;
    return img.currentSrc === srcUrl || img.src === srcUrl;
  };

  ctx.copyToClipboard = async function(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
  };

  // ==================== 单修饰键快捷键：等一下再动手 ====================

  // 划词翻译和悬停翻译的快捷键都是「单独一个修饰键」（Control / Shift / Alt / Meta）。
  // 这和 Alt+A 这类命令键位天生打架：和弦的第一下 keydown 和「只按了那个修饰键」
  // 长得一模一样。立刻动手，用户按一次 Alt+A 就会既划词译一句、又整页译一遍——
  // 两次请求，用自己的 API 就是两份钱。
  //
  // 所以「只按了它」这件事要等一等才算数：
  //   - 松开了它     → 确实只按了它，立刻动手；
  //   - 中间来了别的键 → 这是一个和弦，这一下作废，onChord 收拾首尾。
  //
  // 还有第四种结局：这一按已经被别的用法花掉了（按住划过一段，悬停翻译当场就
  // 译了）。那就 disarmModifierTap() 把它收回——不然松手的那一下会把刚划出来的
  // 译文再切掉一次。
  //
  // 第五种结局要 hold: true 才有：按住超过一瞬也算数。它只属于悬停翻译——那个
  // 手势本来就是「按住，划过哪段译哪段」，光标已经停在段落上时没有别的时机。
  // 划词是「点一下」，按住只说明用户还没想好，或者正伸手去够 C；给它加上这一条
  // 等于把 Ctrl+C 中间的那半秒重新变成一次翻译，而那正是这套机制要挡的事。
  // 同样的道理还挡掉了一类悬停：命令键位占着的修饰键不开按住档，见下面的
  // commandModifiers。
  //
  // 后两种结局都动过手或者花掉了，而键还按着，所以和弦还能来得更晚（见下面的
  // spentTap）。那时候撤不回已经译的那一段，但能把后面那一串拦下来。
  const MODIFIER_TAP_HOLD_MS = 220;

  // 按住档有一个天生的例外：**我们自己的命令键位占着的那个修饰键**。Alt+A 是
  // 先按住 Alt 再去够 A 的，手慢一点就过了 220ms —— 按住档当场替他译了光标底下
  // 那一段，A 随后照样把整页翻了。补跑的 onChord 收得回「按住了」这个状态，收
  // 不回已经发出去的那次请求：这套机制本来要挡的那笔重复账单，从按住档漏回来了。
  //
  // 所以命令占着的修饰键不开按住档，只留「松开才算数」那一条 —— 而 Alt+A 永远
  // 走不到松开（A 一下去就是和弦）。代价是老实的：把悬停键位改成 Alt 的人，光标
  // 停在段落上按住 Alt 不再当场出译文，得松一下手；按住划过下一段照样立刻译，
  // 那条路走的是 mouseover，跟这里无关。默认的 Shift 没被任何命令占，一切照旧。
  //
  // 名单不写死成 'Alt'：键位在 chrome://extensions/shortcuts 里改得掉（见
  // background.js 的 onCommand）。有人把它改成 Ctrl+Shift+Y，撞上的就成了默认的
  // Shift —— 写死 'Alt' 的话这一层等于没装。
  const COMMAND_MODIFIER_TOKENS = {
    alt: 'Alt', option: 'Alt', '\u2325': 'Alt',
    shift: 'Shift', '\u21e7': 'Shift',
    ctrl: 'Control', control: 'Control', macctrl: 'Control', '\u2303': 'Control',
    command: 'Meta', cmd: 'Meta', search: 'Meta', '\u2318': 'Meta'
  };

  // Chrome 按平台印键位：Windows/Linux 上是 'Alt+A'，macOS 上是 '\u2325A'（e2e 里
  // 那条 commands 断言就钉着这两种）。两种都认，别的平台再变也只是多一个名字。
  function collectCommandModifiers(shortcuts) {
    const found = new Set();
    for (const shortcut of shortcuts || []) {
      const text = String(shortcut || '');
      for (const part of text.split('+')) {
        const named = COMMAND_MODIFIER_TOKENS[part.trim().toLowerCase()];
        if (named) found.add(named);
      }
      for (const glyph of text) {
        const symbol = COMMAND_MODIFIER_TOKENS[glyph];
        if (symbol) found.add(symbol);
      }
    }
    return found;
  }

  // manifest 里声明的那一份先垫上：页面刚打开、还没问到答案的那几百毫秒也得是
  // 对的，而那正好是用户伸手按快捷键的时候。
  let commandModifiers = new Set();
  try {
    const commands = chrome.runtime.getManifest().commands || {};
    const suggested = [];
    for (const entry of Object.values(commands)) {
      if (entry && entry.suggested_key) suggested.push(...Object.values(entry.suggested_key));
    }
    commandModifiers = collectCommandModifiers(suggested);
  } catch (error) {
    // 上下文没了（扩展刚更新）。名单空着只是少一层保护，不该把整个内容脚本带塌。
  }

  // 真正生效的那一份只有服务工作者够得着（chrome.commands 不对内容脚本开放）。
  // 它**只会把名单变长**：用户改过的键位可能多占一个修饰键，那一个必须补上；
  // 而把 manifest 声明的那个从名单里摘掉，换来的只是一个「悬停键位也改成了 Alt」
  // 的人少松一次手，赌的却是这条消息在每台机器上都答得又对又准。
  //
  // 只在装载时问一次不够：键位是在 chrome://extensions/shortcuts 里改的，那是
  // **另一个标签页**，而此刻已经开着的每一页手里都还是旧名单。改成 Ctrl+Shift+Y
  // 的人回到这一页，按住 Shift 超过一瞬 —— 这一层要挡的那次重复请求原样回来。
  //
  // 所以回到这一页就重问一次。这个时机跑不掉：他必须离开这一页才改得成，也必须
  // 回来才用得上，而 focus 一定排在他按下第一个键之前。节流是为了把 focus 和
  // visibilitychange 成对到达的那两下并成一次。
  const COMMAND_REFRESH_THROTTLE_MS = 1000;
  let commandRefreshedAt = 0;

  function refreshCommandModifiers() {
    const now = Date.now();
    if (commandRefreshedAt && now - commandRefreshedAt < COMMAND_REFRESH_THROTTLE_MS) return;
    commandRefreshedAt = now;
    try {
      chrome.runtime.sendMessage({ type: 'COMMAND_SHORTCUTS' }, (response) => {
        if (chrome.runtime.lastError) return;
        if (!response || !Array.isArray(response.shortcuts)) return;
        for (const modifier of collectCommandModifiers(response.shortcuts)) {
          commandModifiers.add(modifier);
        }
      });
    } catch (error) {
      // 上下文没了。垫着的那份 manifest 名单照样管用。
    }
  }

  refreshCommandModifiers();
  window.addEventListener('focus', refreshCommandModifiers);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshCommandModifiers();
  });

  let pendingTap = null;

  // 已经花掉、而键还按着的那一下。和弦可以来得比这晚：按住 Alt 超过一瞬（按住
  // 档自己动了手）、或者按着 Alt 先划了一段（悬停当场就译了），再去够 A。动过
  // 的手收不回来 —— 请求已经付过了，把刚出来的译文再撤掉只会更怪 —— 但后面那
  // 一串拦得住：接着来的那个键在这里把 onChord 补跑一次，悬停据此把「按住了」
  // 收回。不补这一下，hotkeyDown 会一直是真，松手之前划过的每一段都当按住悬停
  // 译一遍，一个和弦换一串请求，正是第 3 轮挡掉的那件事从慢一点的入法漏回来。
  let spentTap = null;

  function settleModifierTap(outcome) {
    const tap = pendingTap;
    if (!tap) return;
    pendingTap = null;
    clearTimeout(tap.timer);
    // 动没动手是一回事，这一按还值不值得盯是另一回事：只要键还按着、这一按已经
    // 有了去向（自己动了手，或者被按住划花掉了），和弦就还可能来。
    if (outcome === 'hold' || outcome === 'spent') spentTap = tap;
    if (outcome === 'hold' || outcome === 'fire') tap.run();
    else if (outcome === 'chord' && tap.onChord) tap.onChord();
  }

  function settleSpentTap(outcome) {
    const tap = spentTap;
    if (!tap) return;
    spentTap = null;
    if (outcome === 'chord' && tap.onChord) tap.onChord();
  }

  ctx.armModifierTap = function(key, run, options) {
    settleModifierTap('drop');
    settleSpentTap('drop');
    const opts = options || {};
    const tap = { key, run, onChord: opts.onChord || null, timer: 0 };
    if (opts.hold && !commandModifiers.has(key)) {
      tap.timer = setTimeout(() => {
        if (pendingTap === tap) settleModifierTap('hold');
      }, MODIFIER_TAP_HOLD_MS);
    }
    pendingTap = tap;
  };

  ctx.disarmModifierTap = function() {
    settleModifierTap('spent');
  };

  window.addEventListener('keydown', (event) => {
    // 按住不放会一直重复发 keydown，那还是同一下。
    if (pendingTap && event.key !== pendingTap.key) settleModifierTap('chord');
    else if (spentTap && event.key !== spentTap.key) settleSpentTap('chord');
  }, true);

  window.addEventListener('keyup', (event) => {
    if (pendingTap && event.key === pendingTap.key) settleModifierTap('fire');
    else if (spentTap && event.key === spentTap.key) settleSpentTap('drop');
  }, true);

  // 切走了标签页（Alt+Tab、点到别的窗口），手上这一下就不作数了。
  // 不带 capture：只要窗口自己失焦，不管页面里哪个输入框换了焦点。
  window.addEventListener('blur', () => {
    settleModifierTap('drop');
    settleSpentTap('drop');
  });
})();
