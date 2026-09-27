// Blab Translation —— 输入框上的「译成 X」芯片。
//
// 在一个英文页面上敲中文，或者在中文论坛上敲英文，是同一件事：你正在用一门
// 不是这一页的语言写字，而你多半想让对面读得懂。这颗芯片就开在输入框旁边，只在
// 语言对不上的时候出现，点一下，译文直接写进这个框（D-352）：多行的框在原文
// 后面换一行接上译文，单行的框用译文替换原文，Ctrl/Cmd+Z 一步撤回。怎么写进去
// 归 content/content-input-writeback.js；这里管什么时候写、写之前核对什么。
//
// 四条规矩，写死在这里：
//
// 1. **点击才译。** 判语言用的是 chrome.i18n.detectLanguage，本地的，不出机器；
//    在点下去之前没有任何东西发往任何服务器。
// 2. **判不准就不出声。** 语言判断走 ctx.builtinTranslator.detectStandaloneLang，
//    它没把握时答空串（见 content-translation-engine.js 里那段注释）。一颗因为
//    把 "hello" 判成塞尔维亚语而冒出来的芯片，比没有芯片糟得多。
// 3. **框变了就不写。** 点下去到译文回来之间，用户又改了字、或者焦点去了别的
//    框，这份译文就是给一段已经不存在的文字的。不写，芯片回到可点的样子。
// 4. **不替用户提交。** 不发 Enter、不发 submit、不把焦点挪去别处。
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
  // 点下去之后、译文回来之前的那一次请求：{ field, text }。译文回来时拿身份比，
  // 不是它了（芯片被收走、用户改了字、又点了一次）就说明这份译文没人要了。
  let pending = null;
  // 每个框最后一次写完之后的样子。框里还是这段字，芯片就不再出来 —— 否则写进去
  // 的「原文 + 译文」又会被判成外语，同一段原文被追加第二遍。
  const written = new WeakMap();

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

  const fieldText = (field) => ctx.inputWriteback.fieldText(field);

  // 焦点事件和 input 事件从 shadow root 里冒出来时，e.target 已经被改写成了
  // shadow host。真正在敲字的那个元素是 composedPath() 的第一个。
  const eventField = (e) => (e.composedPath ? e.composedPath()[0] : e.target);

  function hideChip() {
    chipField = null;
    pending = null;
    detectToken += 1;
    if (chip) chip.remove();
  }

  // idle：可点，写着「译成 X」。busy：正在译，点了不算。error：没译成，框里的字
  // 没动，再点一下就是重试。
  function setChipState(state) {
    if (!chip) return;
    if (state === 'idle') {
      delete chip.dataset.state;
      chip.removeAttribute('aria-busy');
      chip.textContent = t('inputChipTranslateTo').replace('{lang}', ctx.languageName(chip.dataset.targetLang, { inSentence: true }));
    } else {
      chip.dataset.state = state;
      chip.setAttribute('aria-busy', state === 'busy' ? 'true' : 'false');
      chip.textContent = t(state === 'busy' ? 'translating' : 'translationFailed');
    }
    if (chipField) positionChip(chipField);
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
    node.dataset.targetLang = targetLang;
    chipField = field;
    if (!node.isConnected) document.body.appendChild(node);
    setChipState('idle');
  }

  // 这一页是什么语言，以及「译成它」该写成 76 个选项里的哪一个。
  //
  // 页面语言走引擎那份缓存（SPA 换路由时自己过期），不另开一份 —— 两份缓存迟早
  // 会对同一页给出两个答案。normalizeTargetLang 对认不出的语言一律回落 'en'，
  // 所以这里要回头核对一遍：一个科萨语（xh）页面不该长出一颗「译成 English」的芯片。
  async function pageTargetLang() {
    const pageLang = await ctx.builtinTranslator?.pageSourceLang?.();
    if (!pageLang) return null;
    const target = ctx.normalizeTargetLang(pageLang);
    if (!ctx.isSameLanguage(target, pageLang)) return null;
    return { pageLang, target };
  }

  async function evaluateField(field) {
    // 这个框的译文还在路上：芯片正显示「翻译中」，不能被一次重新判语言改回「译成 X」。
    if (pending && pending.field === field) return;
    const token = (detectToken += 1);
    if (!chipEnabled() || !isEligibleField(field)) {
      hideChip();
      return;
    }

    if (settleLateWrite(field)) return;
    const current = fieldText(field);
    if (written.has(field) && ctx.inputWriteback.sameText(written.get(field), current)) {
      if (chipField === field) hideChip();
      return;
    }
    const text = current.trim();
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
    if (!ctx.inputWriteback.hasFocus(field)) {
      if (chipField === field) hideChip();
      return;
    }
    showChip(field, page.target);
  }

  function scheduleEvaluate(field) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => evaluateField(field), DETECT_DEBOUNCE_MS);
  }

  // 上一次写回核对没过，但字晚一拍已经落进框里了（见 content-input-writeback.js 的
  // landed）：就当写成了 —— 记下、芯片退场、不再发请求，更不再追加一份。
  function settleLateWrite(field) {
    if (!ctx.inputWriteback.landed(field)) return false;
    written.set(field, fieldText(field));
    if (chipField === field) hideChip();
    return true;
  }

  // 点下去：译，然后写回。译文回来时逐条核对 —— 还是不是这一次请求、框里的字
  // 变没变、焦点还在不在这个框上 —— 任何一条对不上都不写，芯片回到可点。
  async function onChipClick() {
    const field = chipField;
    if (!field || pending) return;
    if (settleLateWrite(field)) return;
    const targetLang = chip.dataset.targetLang || '';
    const snapshot = fieldText(field);
    const text = snapshot.trim();
    if (!text) return;

    const request = { field, text: snapshot };
    pending = request;
    setChipState('busy');
    let writing = false;
    try {
      const response = await ctx.requestTranslation({
        type: 'TRANSLATE',
        text,
        targetLang,
        mode: 'text',
        // 用户敲的字跟这一页没有关系：不声明的话内置引擎拿页面语言当源语言，
        // 英文页上敲的中文就成了 en→en，被同语言短路原样退回。
        standaloneText: true
      });
      if (pending !== request) return;
      if (response.error) throw new Error(response.error);
      if (fieldText(field) !== snapshot || !ctx.inputWriteback.hasFocus(field)) {
        pending = null;
        setChipState('idle');
        return;
      }
      // 先放掉 pending 再写：写进去时框会发 input 事件，那不是用户在改字。
      pending = null;
      writing = true;
      await ctx.inputWriteback.write(field, response.translation);
      written.set(field, fieldText(field));
      if (chipField === field) hideChip();
    } catch (error) {
      console.warn('Blab Translation: input chip translate/write failed', error);
      // 已经作废的请求（芯片收走了、用户改了字）失败了，芯片上没有它的位置。
      if (!writing && pending !== request) return;
      pending = null;
      if (chipField === field) setChipState('error');
    }
  }

  function onFocusIn(e) {
    const field = eventField(e);
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
    if (chipField && eventField(e) === chipField) hideChip();
  }

  function onInput(e) {
    const field = eventField(e);
    if (!isEligibleField(field)) return;
    // 译文还在路上用户又改了字：那份译文作废，芯片回到可点，按新字重新判。
    if (pending && pending.field === field) {
      pending = null;
      setChipState('idle');
    }
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
    // 自己维护模型的编辑器（Lexical 这一类）取消 beforeinput、自己重画，浏览器就
    // 不再发 input —— 只听 input，在这类框里敲多少字芯片都不会醒。
    document.addEventListener('beforeinput', onInput, true);
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
