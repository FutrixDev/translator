// Blab Translation — 页内拾取器：描框和工具条
//
// 全部挂在一个根节点 #ai-translator-rule-picker 下面：collect.js 认这个根（不收
// 我们自己的界面），popup.css 的宿主隔离重置也认它。根和描框都不接指针
// （pointer-events: none），指针穿过去落在页面元素上，picker.js 在 window 的
// capture 阶段截住；只有工具条接指针。
//
// 这里只管画：建节点、把描框贴到一个 rect 上、决定工具条贴上边还是下边、填
// 文案和计数。什么时候画、点了做什么，是 picker.js 的事。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const picker = (ctx.picker = ctx.picker || {});
  const t = (key) => ctx.t(key);

  const ROOT_ID = 'ai-translator-rule-picker';
  const EDGE = 8;

  // 按钮写成标记里的 class="…"：host-css-containment 的单测从标记里读控件类名，
  // 再查每条管控件的规则都压得过主题的 :hover。文案一律用 textContent 填。
  const TEMPLATE = `
    <div class="ai-translator-picker-outline" hidden></div>
    <div class="ai-translator-picker-bar" role="dialog">
      <p class="ai-translator-picker-hint"></p>
      <div class="ai-translator-picker-row" data-when="locked" hidden>
        <input class="ai-translator-picker-input" type="text" spellcheck="false" autocomplete="off">
        <span class="ai-translator-picker-count" aria-live="polite"></span>
      </div>
      <div class="ai-translator-picker-row">
        <button type="button" class="ai-translator-picker-btn" data-act="parent" data-when="locked" hidden></button>
        <button type="button" class="ai-translator-picker-btn" data-act="exclude" data-when="locked" hidden></button>
        <button type="button" class="ai-translator-picker-btn" data-act="keepOriginal" data-when="locked" hidden></button>
        <button type="button" class="ai-translator-picker-btn" data-act="include" data-when="locked" hidden></button>
        <button type="button" class="ai-translator-picker-btn" data-act="cancel"></button>
      </div>
      <p class="ai-translator-picker-tip" data-tip="exclude" data-when="locked" hidden></p>
      <p class="ai-translator-picker-tip" data-tip="keepOriginal" data-when="locked" hidden></p>
      <p class="ai-translator-picker-status" role="status" hidden></p>
    </div>
  `;

  const LABELS = {
    parent: 'pickerParent',
    exclude: 'pickerExclude',
    keepOriginal: 'pickerKeepOriginal',
    include: 'pickerInclude',
    cancel: 'pickerCancel',
  };
  const TIPS = { exclude: 'pickerExcludeTip', keepOriginal: 'pickerKeepOriginalTip' };
  const FIELDS = ['exclude', 'keepOriginal', 'include'];

  function buildRoot() {
    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.setAttribute('translate', 'no');
    root.innerHTML = TEMPLATE;
    const q = (sel) => root.querySelector(sel);
    const parts = {
      root,
      outline: q('.ai-translator-picker-outline'),
      bar: q('.ai-translator-picker-bar'),
      hint: q('.ai-translator-picker-hint'),
      input: q('.ai-translator-picker-input'),
      count: q('.ai-translator-picker-count'),
      status: q('.ai-translator-picker-status'),
      buttons: {},
    };
    parts.hint.textContent = t('pickerHint');
    parts.input.setAttribute('aria-label', t('pickerHint'));
    for (const button of root.querySelectorAll('[data-act]')) {
      button.textContent = t(LABELS[button.dataset.act]);
      parts.buttons[button.dataset.act] = button;
    }
    // 两句说明是看得见的一行，不放在 title 上：触屏没有悬停，title 等于没写。
    // 按钮用 aria-describedby 指过去，读屏念按钮时连说明一起念。
    for (const tip of root.querySelectorAll('[data-tip]')) {
      const field = tip.dataset.tip;
      tip.id = `${ROOT_ID}-tip-${field}`;
      tip.textContent = `${t(LABELS[field])}: ${t(TIPS[field])}`;
      parts.buttons[field].setAttribute('aria-describedby', tip.id);
    }
    return parts;
  }

  /** 描框贴到 rect 上；没有 rect 就藏起来。 */
  function placeOutline(parts, rect) {
    const { outline } = parts;
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      outline.hidden = true;
      return;
    }
    outline.hidden = false;
    outline.style.left = `${rect.left}px`;
    outline.style.top = `${rect.top}px`;
    outline.style.width = `${rect.width}px`;
    outline.style.height = `${rect.height}px`;
  }

  /**
   * 工具条左右各留 8px 贴满视口宽，默认贴底边；锁定的目标压在底边那一带时
   * 挪到顶边，免得挡住用户正在看的东西。高度由 CSS 的 max-height 兜住。
   */
  function placeBar(parts, rect) {
    const { bar } = parts;
    bar.dataset.edge = 'bottom';
    if (!rect) return;
    const barTop = window.innerHeight - EDGE - bar.offsetHeight;
    if (rect.bottom > barTop && rect.top < window.innerHeight) bar.dataset.edge = 'top';
  }

  /** 点中之后露出选择器那一排；没点中时只有提示和取消。 */
  function setLocked(parts, locked) {
    for (const el of parts.root.querySelectorAll('[data-when="locked"]')) el.hidden = !locked;
  }

  /** 选择器和它的命中数；无效或 0 处时三个动作按钮置灰。 */
  function showCount(parts, count) {
    parts.count.textContent = count === null
      ? t('customRuleSelectorInvalid').replace('{selector}', parts.input.value)
      : t('pickerMatches').replace('{n}', String(count));
    parts.count.dataset.invalid = count === null ? 'true' : 'false';
    for (const field of FIELDS) parts.buttons[field].disabled = !count;
  }

  /**
   * 工具条里此刻能拿到焦点的控件，按文档顺序（输入框在按钮那一排上面，parts.buttons
   * 按标记顺序填）：藏着的一排和置灰的按钮不算。「取消」一直在，所以不会是空的。
   */
  function focusables(parts) {
    return [parts.input, ...Object.values(parts.buttons)]
      .filter((el) => !el.disabled && !el.closest('[hidden]'));
  }

  function showStatus(parts, text) {
    parts.status.hidden = !text;
    parts.status.textContent = text || '';
  }

  Object.assign(picker, {
    ROOT_ID,
    FIELDS,
    buildRoot,
    placeOutline,
    placeBar,
    setLocked,
    showCount,
    focusables,
    showStatus,
  });
})();
