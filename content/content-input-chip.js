// Blab Translation —— 输入框上的「译成 X」芯片。
//
// 在一个英文页面上敲中文，或者在中文论坛上敲英文，是同一件事：你正在用一门
// 不是这一页的语言写字，而你多半想让对面读得懂。输入翻译这个功能早就有了
// （content/content-input-dialog.js），可它唯一的入口是悬浮球菜单里的一行 ——
// 要想起它存在，要点两次，还要把刚敲的字再复制一遍。所以没人用。
//
// 这颗芯片就是那扇门，开在门本来该在的地方：输入框旁边，只在语言对不上的时候
// 出现，点一下，文字和目标语言一起送进对话框。
//
// 三条规矩，写死在这里：
//
// 1. **永不自动改写用户输入。** 芯片只是把文字**复制**进对话框，原输入框一个
//    字符都不动。用户自己决定要不要把译文拿回去。
// 2. **点击才译。** 判语言用的是 chrome.i18n.detectLanguage，本地的，不出机器；
//    在点下去之前没有任何东西发往任何服务器。
// 3. **判不准就不出声。** 语言判断走 ctx.builtinTranslator.detectStandaloneLang，
//    它没把握时答空串（见 content-translation-engine.js 里那段注释）。一颗因为
//    把 "hello" 判成塞尔维亚语而冒出来的芯片，比没有芯片糟得多。
(function () {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const { settings } = ctx;
  const t = ctx.t;

  const CHIP_ID = 'ai-translator-input-chip';
  // 敲字的时候不停地判语言没有意义：一句话写到一半，前半句的语言和整句常常不是
  // 同一个答案。停下来才问。
  const DETECT_DEBOUNCE_MS = 400;
  // detectStandaloneLang 自己还有一道字数门（拉丁 8 字、非拉丁 2 字）。这里这道
  // 只是省掉那些一望而知问不出结果的调用。
  const MIN_TEXT_CHARS = 2;
  const GAP = 4;

  let chip = null;
  // 芯片正贴着哪个输入框。null 表示现在没有芯片。
  let chipField = null;
  let debounceTimer = 0;
  // 判语言是异步的，而用户还在打字。每次发起判断都领一个号，回来的时候号对不上
  // 就说明这个答案是给上一段文字的，丢掉 —— 否则一个迟到的答案会给一段早就变了
  // 的文字挂上芯片。
  let detectToken = 0;

  function chipEnabled() {
    return settings.showInputTranslateChip !== false;
  }

  function isOurNode(el) {
    return !!el.closest('.ai-translator-popup, [id^="ai-translator"], [class*="ai-translator"]');
  }

  // 能敲字、而且敲的是「话」的框。密码、邮箱、网址、电话、数字都排除：那些框里
  // 的内容没有语言可言，一颗「译成英语」的芯片挂在密码框上只会吓人。
  const TEXTUAL_INPUT_TYPES = new Set(['text', 'search']);

  function isEligibleField(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.disabled || el.readOnly) return false;
    if (isOurNode(el)) return false;

    const tag = el.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') return TEXTUAL_INPUT_TYPES.has((el.type || 'text').toLowerCase());
    return el.isContentEditable === true;
  }

  function fieldText(el) {
    if (!el) return '';
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT') return el.value || '';
    return el.innerText || el.textContent || '';
  }

  function hideChip() {
    chipField = null;
    detectToken += 1;
    if (chip) chip.remove();
  }

  function ensureChip() {
    if (chip) return chip;
    // div + role，跟 OCR 悬浮按钮一样。页面主题普遍写 `.kit button { … }`，一个
    // 真 <button> 得把那一族规则逐条挡回去；不是 button 就没有这一层。
    chip = document.createElement('div');
    chip.id = CHIP_ID;
    chip.setAttribute('role', 'button');
    // 按下去的那一刻就把焦点按住。不拦的话浏览器会把焦点从输入框收走，页面上那些
    // 「失焦即收起」的编辑器会当场把框连同用户写的东西一起关掉。
    chip.addEventListener('mousedown', (e) => e.preventDefault());
    chip.addEventListener('click', onChipClick);
    return chip;
  }

  // 贴在输入框右下角的**外面**，不是里面。里面会压住用户正在写的那一行 —— 单行
  // 输入框尤其如此。下面放不下就翻到上面去。
  function positionChip(field) {
    if (!chip || !field) return;
    const rect = field.getBoundingClientRect();
    const width = chip.offsetWidth || 0;
    const height = chip.offsetHeight || 0;
    const below = rect.bottom + GAP;
    const top = below + height + GAP > window.innerHeight
      ? Math.max(GAP, rect.top - height - GAP)
      : below;
    chip.style.top = `${top}px`;
    chip.style.left = `${Math.max(GAP, Math.min(window.innerWidth - width - GAP, rect.right - width))}px`;
  }

  function showChip(field, targetLang) {
    const node = ensureChip();
    node.textContent = t('inputChipTranslateTo').replace('{lang}', ctx.getTargetLangLabel(targetLang));
    node.dataset.targetLang = targetLang;
    chipField = field;
    if (!node.isConnected) document.body.appendChild(node);
    positionChip(field);
  }

  // 这一页是什么语言，以及「译成它」该写成十个选项里的哪一个。
  //
  // 页面语言走引擎那份缓存（SPA 换路由时自己过期），不另开一份 —— 两份缓存迟早
  // 会对同一页给出两个答案。normalizeTargetLang 对认不出的语言一律回落 'en'，
  // 所以这里要回头核对一遍：一个瑞典语页面不该长出一颗「译成 English」的芯片。
  async function pageTargetLang() {
    const pageLang = await ctx.builtinTranslator?.pageSourceLang?.();
    if (!pageLang) return null;
    const target = ctx.normalizeTargetLang(pageLang);
    if (!ctx.isSameLanguage(target, pageLang)) return null;
    return { pageLang, target };
  }

  async function evaluateField(field) {
    const token = (detectToken += 1);
    if (!chipEnabled() || !isEligibleField(field)) {
      hideChip();
      return;
    }

    const text = fieldText(field).trim();
    if (text.length < MIN_TEXT_CHARS) {
      if (chipField === field) hideChip();
      return;
    }

    const page = await pageTargetLang();
    if (token !== detectToken) return;
    if (!page) {
      if (chipField === field) hideChip();
      return;
    }

    const inputLang = await ctx.builtinTranslator?.detectStandaloneLang?.(text);
    if (token !== detectToken) return;
    // 判不出来，或者本来就是这一页的语言 —— 两种情况都没有话要说。
    if (!inputLang || ctx.isSameLanguage(inputLang, page.pageLang)) {
      if (chipField === field) hideChip();
      return;
    }

    // 上面两个 await 之间用户可能已经点去了别处。芯片只贴着焦点所在的那个框。
    if (document.activeElement !== field) {
      if (chipField === field) hideChip();
      return;
    }
    showChip(field, page.target);
  }

  function scheduleEvaluate(field) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => evaluateField(field), DETECT_DEBOUNCE_MS);
  }

  function onChipClick() {
    const field = chipField;
    const targetLang = chip?.dataset.targetLang || '';
    const text = fieldText(field).trim();
    hideChip();
    if (!text || !ctx.showInputTranslateDialog) return;
    ctx.showInputTranslateDialog({ text, targetLang });
  }

  function onFocusIn(e) {
    const field = e.target;
    if (chipField && chipField !== field) hideChip();
    if (!isEligibleField(field)) {
      // 焦点落到别处了。芯片自己不接管焦点（mousedown 被拦住了），所以这就是
      // 「用户走了」。
      if (chipField) hideChip();
      return;
    }
    scheduleEvaluate(field);
  }

  // 点到页面空白处不会有任何东西接管焦点，于是 focusin 根本不响 —— 光靠它，
  // 芯片会留在一个已经失焦的框旁边。
  function onFocusOut(e) {
    if (chipField && e.target === chipField) hideChip();
  }

  function onInput(e) {
    const field = e.target;
    if (!isEligibleField(field)) return;
    scheduleEvaluate(field);
  }

  function onViewportChange() {
    if (chipField) positionChip(chipField);
  }

  function setupInputTranslateChip() {
    // 一律用捕获期的文档级监听：页面上的编辑器常常把自己的事件停在半路，而且
    // 输入框是 SPA 换了又换的东西，逐个绑监听器等于绑不住。
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('scroll', onViewportChange, true);
    window.addEventListener('resize', onViewportChange, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && chipField) hideChip();
    }, true);
  }

  ctx.setupInputTranslateChip = setupInputTranslateChip;
  // 开关被关掉时，bootstrap 的存储监听立刻来收走当前这一颗。
  ctx.hideInputTranslateChip = hideChip;
})();
