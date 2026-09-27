// Blab Translation — 页内拾取器：入口
//
// 用户在页面上点一块，存成本站规则的 exclude / keepOriginal / include 一条选择器
// （设计 §5）。两个入口：悬浮球菜单的 edit-site-rule，popup 的按钮发来的
// OPEN_RULE_PICKER（content-messaging.js）。
//
// 打开后在 window 的 capture 阶段截住指针、鼠标、点击和按键：不落在我们根节点
// 里的一律 preventDefault + stopPropagation，页面上的链接和按钮都不响应。目标取
// composedPath()[0]，能穿进 open shadow root。Esc 或「取消」拆掉全部节点和监听，
// 不留痕迹。
//
// 保存走 CustomRules.request('addSelector')，校验只在那一处（shared/custom-rules.js
// 的 validateRule / sanitizeCss）：这里不另写一份。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const picker = (ctx.picker = ctx.picker || {});
  const t = (key) => ctx.t(key);

  const BLOCKED = ['pointermove', 'pointerdown', 'mousedown', 'mouseup', 'click', 'keydown'];

  let parts = null;
  let hovered = null;
  let locked = null;
  let saving = false;

  function inRoot(event) {
    return !!parts && event.composedPath().includes(parts.root);
  }

  // 我们自己的界面（悬浮球、菜单、卡片）不给点；译文节点换成它所在的元素 ——
  // 给译文节点写规则，下一轮它就不存在了。
  function targetOf(event) {
    let el = event.composedPath().find((node) => node && node.nodeType === 1) || null;
    if (!el || el.closest('[id^="ai-translator-"], .ai-translator-popup')) return null;
    const ours = el.closest('.ai-translator-inline-block');
    if (ours) el = ours.parentElement;
    if (!el || el === document.documentElement || el === document.body) return null;
    return el;
  }

  function current() {
    return locked || hovered;
  }

  function redraw() {
    if (!parts) return;
    const el = current();
    const rect = el && el.isConnected ? el.getBoundingClientRect() : null;
    picker.placeOutline(parts, rect);
    picker.placeBar(parts, locked && rect);
  }

  /** 当前输入框里的选择器命中几处；无效是 null。我们自己的节点（含译文里的克隆）不算。 */
  function countMatches() {
    const selector = parts.input.value.trim();
    if (!selector) return null;
    try {
      return ctx.queryAllDeep(selector).filter(picker.isPageNode).length;
    } catch (_) {
      return null;
    }
  }

  function refreshCount() {
    picker.showCount(parts, countMatches());
  }

  function lock(el) {
    locked = el;
    parts.input.value = picker.selectorFor(el);
    picker.setLocked(parts, true);
    picker.showStatus(parts, '');
    refreshCount();
    redraw();
    parts.input.focus({ preventScroll: true });
  }

  /**
   * 拾取器开着时焦点只在工具条里转：Tab 往后、Shift+Tab 往前，两头绕回来。焦点
   * 还在页面上时，第一下 Tab 把它带进工具条。不交给浏览器走：工具条挂在 body 最
   * 后，浏览器的下一站是页面或地址栏，而页面上的按键全被截住，出去就回不来了。
   */
  function cycleFocus(event) {
    event.preventDefault();
    event.stopPropagation();
    const stops = picker.focusables(parts);
    const at = stops.indexOf(document.activeElement);
    const step = event.shiftKey ? -1 : 1;
    const next = at === -1 ? (step > 0 ? 0 : stops.length - 1) : (at + step + stops.length) % stops.length;
    stops[next].focus({ preventScroll: true });
  }

  function onBlocked(event) {
    if (event.type === 'keydown' && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.type === 'keydown' && event.key === 'Tab' && !event.altKey && !event.ctrlKey && !event.metaKey) {
      cycleFocus(event);
      return;
    }
    if (inRoot(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.type === 'pointermove' && !locked) {
      const el = targetOf(event);
      if (el !== hovered) {
        hovered = el;
        redraw();
      }
    } else if (event.type === 'click') {
      // 页面脚本合成的点击照样截下，但不锁定：选中什么只由用户的真指针决定
      // （同 content-utils.js 的 contextmenu）。
      if (!event.isTrusted) return;
      const el = targetOf(event);
      if (el && !saving) lock(el);
    }
  }

  function onViewport() {
    redraw();
  }

  /**
   * 存失败时给一句能让用户动手的话，拾取器保持打开。
   * - customRuleCssUnsafe：本站胜出那条规则的 CSS 不安全，追加也被拒（validateRule
   *   对整条规则跑）。改 CSS 只能去设置页，所以这句指过去（pickerCssUnsafe）。
   * - 别的已知键照原样查文案；customRuleSaveFailed 已经在服务工作者那一层记过日志。
   * - 表外的错误（扩展上下文失效之类）在这一层被接住，在这一层记一条。
   */
  function errorText(error, selector) {
    const key = globalThis.CustomRules.userErrorKey(error);
    if (key === 'customRuleCssUnsafe') return t('pickerCssUnsafe');
    if (key) return t(key).replace('{selector}', selector);
    console.error('Blab Translation: rule picker save failed', error);
    return t('customRuleSaveFailed');
  }

  function setBusy(busy) {
    for (const button of Object.values(parts.buttons)) button.disabled = busy;
    if (!busy) refreshCount();
  }

  async function save(field) {
    if (saving) return;
    // 这一次打开的工具条。等回话的时候用户可能按了 Esc，甚至又开了一次；回话只
    // 落在它自己那一次上。
    const own = parts;
    const selector = own.input.value.trim();
    saving = true;
    setBusy(true);
    picker.showStatus(own, '');
    try {
      await globalThis.CustomRules.request('addSelector', {
        host: location.hostname,
        path: location.pathname,
        field,
        selector,
      });
    } catch (error) {
      const text = errorText(error, selector);
      if (parts !== own) {
        ctx.showAutoStatusNotice(text);
        return;
      }
      saving = false;
      setBusy(false);
      picker.showStatus(own, text);
      return;
    }
    if (parts === own) close();
    // 右下角那条窄条是页面上唯一说话的地方（content-auto-status.js 的 setNotice），
    // 不另造一条。
    ctx.showAutoStatusNotice(t('pickerSaved'));
  }

  function onBarClick(event) {
    // 工具条在页面自己的 DOM 里，页面脚本 button.click() 就能替用户写一条规则。
    // 只认浏览器发的点击；键盘在按钮上按回车或空格发出的 click 也是可信的。
    if (!event.isTrusted) return;
    const button = event.target.closest('[data-act]');
    if (!button || button.disabled) return;
    const act = button.dataset.act;
    if (act === 'cancel') close();
    else if (act === 'parent') {
      const up = locked && (locked.parentElement || (locked.getRootNode() || {}).host);
      if (up && up !== document.documentElement && up !== document.body) lock(up);
    } else if (picker.FIELDS.includes(act)) save(act);
  }

  function listen(on) {
    const method = on ? 'addEventListener' : 'removeEventListener';
    for (const type of BLOCKED) window[method](type, onBlocked, true);
    window[method]('scroll', onViewport, true);
    window[method]('resize', onViewport);
  }

  /**
   * 能不能在这一页开。只在顶层 frame；主机名生不出规则键的页面（file:// 等）不开
   * —— 存不进去。黑名单不拦：它只拒自动翻译，手动整页翻译在那里照样用得上规则
   * （设计 §5.1）。悬浮球菜单画不画这一项也问它。
   */
  function canOpen() {
    return ctx.frameRole === 'top' && !!globalThis.SiteRules.normalizeHost(location.hostname);
  }

  /** 开拾取器；重复调用无害。开不了回 false。 */
  function open() {
    if (!canOpen()) return false;
    if (parts) return true;
    parts = picker.buildRoot();
    saving = false;
    parts.bar.addEventListener('click', onBarClick);
    parts.input.addEventListener('input', refreshCount);
    hovered = null;
    locked = null;
    picker.setLocked(parts, false);
    document.body.appendChild(parts.root);
    // 右下角的追问条会压在低处的目标上：开着的这段时间它让位。
    ctx.yieldAutoStatus(true);
    redraw();
    listen(true);
    return true;
  }

  /** 拆掉全部节点和监听，页面立刻还给用户，不留痕迹。 */
  function close() {
    if (!parts) return;
    listen(false);
    parts.root.remove();
    parts = null;
    hovered = null;
    locked = null;
    ctx.yieldAutoStatus(false);
  }

  function isOpen() {
    return !!parts;
  }

  Object.assign(picker, { canOpen, open, close, isOpen });
})();
