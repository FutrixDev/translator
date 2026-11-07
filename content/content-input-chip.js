// Blab Translation —— 输入框上的「译成 X ▾」按钮（D-352，D-1031/D-1032 §4）。
//
// 写作框旁只有这一个按钮。点主体是翻译：译文直接写进这个框（多行的框在原文后面
// 换一行接上，单行的框用译文替换原文），Ctrl/Cmd+Z 一步撤回。点 ▾ 是菜单
// （content/content-input-menu.js）：换一门目标语言翻译，或者调整语气。怎么写进去
// 归 content/content-input-writeback.js；这里管什么时候出现、写之前核对什么、
// 每个框的「原文 / 译文段 / 缓存」这份会话。
//
// 几条规矩，写死在这里：
//
// 1. **点击才译。** 判语言用的是 chrome.i18n.detectLanguage，本地的，不出机器；
//    在点下去之前没有任何东西发往任何服务器。
// 2. **出现只看框和长度（§4.2）。** 写作框、停顿 400ms 后够长就出现 —— 不再要求
//    「输入语言 ≠ 页面语言」：同语言时只想调语气的人也要有入口。判语言只用来定
//    默认目标（§4.3）和语气的 sourceLang，判不准（空串）就按「没判出来」处理。
// 3. **框变了就不写。** 点下去到结果回来之间，用户又改了字、或者焦点去了别的框，
//    这份结果就是给一段已经不存在的文字的。不写，按钮回到可点的样子。语气替换前
//    再复读一遍落点（writeback 的 intact），对不上就以框里现在的字为新原文重来。
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

  let chip = null;
  let label = null;
  let caret = null;
  // 按钮正贴着哪个输入框。null 表示现在没有按钮。
  let chipField = null;
  let debounceTimer = 0;
  // 判语言是异步的，而用户还在打字。每次发起判断都领一个号，回来的时候号对不上
  // 就说明这个答案是给上一段文字的，丢掉。
  let detectToken = 0;
  // 点下去之后、结果回来之前，芯片这个锚上挂着一次 run（ctx.inputMenu.run）：它的
  // still() 答这份结果还有没有人要（按钮被收走、用户改了字都会把它放掉）。
  // 没译成时要给用户看的那一句；空串是没有错。
  let chipError = '';
  // 正在往哪个框里写。写进去时框会发 input 事件，那不是用户在改字。
  let writingField = null;
  // 这一页里在菜单上选过的目标语言：选了就一直用它，压过「页面语言」那一条（§4.3）。
  let chosenTarget = '';
  // 写回核对没过、字却晚一拍落进框里的那一次（landed）：记下那时框里的样子。框里
  // 还是这段字，按钮就不出来 —— 不知道译文段落在哪儿，再点只会追加第二份。
  const lateWritten = new WeakMap();

  // 每个框的会话（§4.4）：
  // - seg：框里最新那一版的落点 `{ mode, start, text, after }`（writeback 的形状）。
  //   没翻译过时它就是整段原文
  // - tones：这段原文的 ctx.inputMenu.toneSource —— 原文、它的语言、seg 现在是哪一版
  //   （shown.lang 空 = 没翻译过，seg 是原文；shown.tone 空 = 没调过语气）和缓存
  // 框里的字不再读作 seg.after（用户手动改过、页面重画过），这份会话就作废。
  const sessions = new WeakMap();

  // 输入法组合（拼音候选框开着）期间，以及结束后这一小段，编辑器还在它的组合模式
  // 里：Draft 要到 compositionend 之后 20ms 才把组合出来的字读回模型，这期间它不接
  // paste，写回就掉到 execCommand 上 —— 正是 c5d37ea 写坏 Draft 的那条路
  // （D-361 S4）。所以这段时间里不判定、不新挂按钮；已经挂着的按钮被点了，只回到
  // 可点，一个字不写。组合结束前最后那个 input 会照常排一轮判定（400ms 之后），
  // 按钮自己会醒过来。
  const COMPOSITION_SETTLE_MS = 50;
  let composing = false;
  let compositionEndedAt = -Infinity;
  const inComposition = () => composing || performance.now() - compositionEndedAt < COMPOSITION_SETTLE_MS;

  function chipEnabled() {
    return settings.showInputTranslateChip !== false;
  }

  const fieldText = (field) => ctx.inputWriteback.fieldText(field);
  const isTextControl = (field) => field.tagName === 'TEXTAREA' || field.tagName === 'INPUT';

  // 焦点事件和 input 事件从 shadow root 里冒出来时，e.target 已经被改写成了
  // shadow host。真正在敲字的那个元素是 composedPath() 的第一个。
  const eventField = (e) => (e.composedPath ? e.composedPath()[0] : e.target);

  // ==================== 会话 ====================

  function newSession(field, sourceLang) {
    const text = fieldText(field);
    const session = { seg: { mode: 'replace', start: isTextControl(field) ? 0 : null, text, after: text } };
    session.tones = ctx.inputMenu.toneSource({
      text,
      sourceLang: sourceLang || '',
      write: (value) => writeTone(field, session, value),
      writeWhileClosed: false,
    });
    sessions.set(field, session);
    return session;
  }

  /** 框里还是这份会话写下的样子就答它，否则作废答 null。 */
  function liveSession(field) {
    const session = sessions.get(field);
    if (session && ctx.inputWriteback.intact(field, session.seg)) return session;
    sessions.delete(field);
    return null;
  }

  async function detectLang(text) {
    return (await ctx.builtinTranslator?.detectStandaloneLang?.(text.trim())) || '';
  }

  /** 会话还在就用它；不在了（用户改过字）就以框里现在的字为新原文重来（§4.4）。 */
  async function ensureSession(field) {
    const live = liveSession(field);
    if (live) return live;
    const text = fieldText(field);
    const sourceLang = await detectLang(text);
    if (fieldText(field) !== text) throw new Error('input chip: the field changed while detecting its language');
    return newSession(field, sourceLang);
  }

  // ==================== 默认目标（§4.3） ====================

  /**
   * 1. 这一页在菜单上选过 → 它。
   * 2. 输入语言判得出、和页面语言不同 → 页面语言（它在 77 个选项里认得出来时）。
   * 3. 否则：上次在菜单里选的（按设备记）→ 设置里的 targetLang → 英文；跳过和输入
   *    语言相同的那一个。输入本身是英文时，最后一档换成界面语言。
   */
  async function targetFor(sourceLang) {
    if (chosenTarget) return chosenTarget;
    const pageLang = await ctx.builtinTranslator?.pageSourceLang?.();
    if (sourceLang && pageLang && !ctx.isSameLanguage(sourceLang, pageLang)) {
      // normalizeTargetLang 对认不出的语言一律回落 'en'：一个科萨语（xh）页面不该
      // 默认「译成 English」，那就落到下面那几档。
      const target = ctx.normalizeTargetLang(pageLang);
      if (ctx.isSameLanguage(target, pageLang)) return target;
    }
    const english = sourceLang && ctx.isSameLanguage(sourceLang, 'en');
    const candidates = [ctx.inputMenu.targetPref.get(), settings.targetLang, english ? ctx.uiLanguage() : 'en'];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const lang = ctx.normalizeTargetLang(candidate);
      if (!sourceLang || !ctx.isSameLanguage(lang, sourceLang)) return lang;
    }
    return ctx.normalizeTargetLang(candidates[candidates.length - 1]);
  }

  // ==================== 按钮 ====================

  function hideChip() {
    chipField = null;
    detectToken += 1;
    if (!chip) return;
    ctx.inputMenu.release(chip);
    // 只收自己打开的那一个：便签对话框结果区的 ▾ 也用同一个菜单。
    if (ctx.inputMenu.isOpen(chip)) ctx.inputMenu.close();
    chip.remove();
  }

  // 三个样子：忙（锚上有 run，data-busy 由菜单写：正在翻译 / 正在调语气，点了不算）；
  // 错（chipError：没译成，框里的字没动，再点一下就是重试 —— 那一句是
  // ctx.thrownTranslationMessage 定的，和别的入口同一句，一行放不下的部分放在 title
  // 里，悬停能读全）；闲（可点，写着「译成 X」）。
  function paint() {
    if (!chip) return;
    const busy = ctx.inputMenu.inflight(chip);
    chip.removeAttribute('title');
    if (busy) {
      delete chip.dataset.state;
      chip.setAttribute('aria-busy', 'true');
      label.textContent = t(busy === 'tone' ? 'toneBusy' : 'translating');
    } else if (chipError) {
      chip.dataset.state = 'error';
      chip.setAttribute('aria-busy', 'false');
      label.textContent = chipError;
      chip.setAttribute('title', chipError);
    } else {
      delete chip.dataset.state;
      chip.removeAttribute('aria-busy');
      label.textContent = ctx.inputMenu.translateLabel(chip.dataset.targetLang);
    }
    placeChip();
  }

  function ensureChip() {
    if (chip) return chip;
    // div + role，跟 OCR 悬浮按钮一样。页面主题普遍写 `.kit button { … }`，一个
    // 真 <button> 得把那一族规则逐条挡回去；不是 button 就没有这一层。
    chip = document.createElement('div');
    chip.id = CHIP_ID;
    chip.setAttribute('role', 'button');
    label = document.createElement('span');
    label.className = 'ai-translator-input-chip-label';
    caret = document.createElement('span');
    caret.className = 'ai-translator-input-chip-caret';
    caret.setAttribute('role', 'button');
    caret.setAttribute('aria-haspopup', 'menu');
    caret.setAttribute('aria-label', t('inputChipMenu'));
    chip.append(label, caret);
    // 按下去的那一刻就把焦点按住。不拦的话浏览器会把焦点从输入框收走，页面上那些
    // 「失焦即收起」的编辑器会当场把框连同用户写的东西一起关掉。
    chip.addEventListener('mousedown', (e) => e.preventDefault());
    chip.addEventListener('click', onChipClick);
    ctx.inputMenu.onBusyChange(chip, paint);
    return chip;
  }

  // 贴在输入框右下角的**外面**，不是里面。里面会压住用户正在写的那一行 —— 单行
  // 输入框尤其如此。下面放不下就翻到上面去（和菜单同一个摆法）。
  //
  // 框已经不在页面上了（React 换掉了整个输入框）：它的矩形是 0，按钮会跳到视口
  // 左上角。收起来。
  function placeChip() {
    if (!chip || !chipField) return;
    if (!chipField.isConnected) {
      hideChip();
      return;
    }
    ctx.inputMenu.placeBeside(chip, chipField.getBoundingClientRect());
  }

  function showChip(field, targetLang) {
    const node = ensureChip();
    node.dataset.targetLang = targetLang;
    chipField = field;
    if (!node.isConnected) document.body.appendChild(node);
    chipError = '';
    paint();
  }

  // ==================== 判定（§4.2） ====================

  function hiddenOnSite() {
    return InputChipHosts.hidden(location.hostname);
  }

  function dismiss(field) {
    if (chipField === field) hideChip();
  }

  async function evaluateField(field) {
    // 这个框的结果还在路上：按钮正显示「翻译中」，不能被一次重新判定改回「译成 X」。
    if ((chipField === field && ctx.inputMenu.inflight(chip)) || writingField === field) return;
    if (inComposition()) return;
    const token = (detectToken += 1);
    if (!chipEnabled() || !ctx.inputFields.isWritingField(field)) {
      hideChip();
      return;
    }

    if (settleLateWrite(field)) return;
    const current = fieldText(field);
    if (lateWritten.has(field) && ctx.inputWriteback.sameText(lateWritten.get(field), current)) {
      dismiss(field);
      return;
    }
    if (!ctx.inputFields.longEnough(current)) {
      dismiss(field);
      return;
    }

    const hidden = await hiddenOnSite();
    if (token !== detectToken) return;
    if (hidden) {
      dismiss(field);
      return;
    }

    // 框里还是上次写下的样子（刚翻译完、刚调过语气）：会话还在，原文的语言也还是
    // 那个；否则以现在的字为原文开一份新的。
    let session = liveSession(field);
    if (!session) {
      const sourceLang = await detectLang(current);
      if (token !== detectToken) return;
      if (fieldText(field) !== current) return;
      session = newSession(field, sourceLang);
    }
    const target = await targetFor(session.tones.sourceLang);
    if (token !== detectToken) return;

    // 上面几个 await 之间用户可能已经点去了别处，或者开始用输入法了。按钮只贴着
    // 焦点所在的那个框。
    if (inComposition()) return;
    if (!ctx.inputWriteback.hasFocus(field)) {
      dismiss(field);
      return;
    }
    showChip(field, target);
  }

  function scheduleEvaluate(field) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => evaluateField(field), DETECT_DEBOUNCE_MS);
  }

  // 上一次写回核对没过，但字晚一拍已经落进框里了（见 content-input-writeback.js 的
  // landed）：就当写成了 —— 记下、按钮退场、不再发请求，更不再追加一份。
  function settleLateWrite(field) {
    if (!ctx.inputWriteback.landed(field)) return false;
    sessions.delete(field);
    lateWritten.set(field, fieldText(field));
    dismiss(field);
    return true;
  }

  // ==================== 翻译 ====================

  async function translate(text, targetLang) {
    // Recorded on dispatch, not on answer; see ctx.rememberRecentTargetLang.
    ctx.rememberRecentTargetLang(targetLang);
    const response = await ctx.requestTranslation({
      type: 'TRANSLATE',
      feature: 'input',
      text: text.trim(),
      targetLang,
      mode: 'text',
      // 用户敲的字跟这一页没有关系：不声明的话内置引擎拿页面语言当源语言，
      // 英文页上敲的中文就成了 en→en，被同语言短路原样退回。
      standaloneText: true
    });
    if (response.error) {
      // 子 frame 的请求经顶层执行，抛出的错误在消息通道上折成了 {error, passFatal}
      // （content/frames/top.js）；把标记接回来，文案才和顶层直接抛出时一样。
      const error = new Error(response.error);
      if (response.passFatal === true) error.passFatal = true;
      throw error;
    }
    return response.translation;
  }

  // 结果回来之后、动手之前的那道核对：框里的字变没变、焦点还在不在这个框上、
  // 输入法有没有开着。
  function stillWanted(field, snapshot) {
    return fieldText(field) === snapshot && ctx.inputWriteback.hasFocus(field) && !inComposition();
  }

  // 把会话里的一版写进框：翻译过就只换译文段，没翻译过走 untranslated()（第一次
  // 翻译追加或替换、语气替换整段）。写进去时框会发 input 事件，那不是用户在改字。
  // 没写成（落点变了、或写完读起来不对）：这份会话已经说不清框里是什么了，丢掉，
  // 下一次以框里现在的字为新原文，不卡在旧落点上（D-1043 M2）。
  async function land(field, session, text, untranslated) {
    writingField = field;
    try {
      session.seg = session.tones.shown.lang
        ? await ctx.inputWriteback.replaceSegment(field, session.seg, text)
        : await untranslated();
    } catch (error) {
      sessions.delete(field);
      throw error;
    } finally {
      writingField = null;
    }
  }

  /**
   * 译成 targetLang 并写回。按钮主体和菜单里的「译成 X」都走这里。框里已经是这门
   * 语言的译文（没调过语气）就什么都不做 —— 再点一次不会追加第二份。
   */
  async function translateField(field, targetLang) {
    if (!field || ctx.inputMenu.inflight(chip)) return;
    chipError = '';
    if (inComposition()) {
      paint();
      return;
    }
    if (settleLateWrite(field)) return;
    const snapshot = fieldText(field);
    if (!snapshot.trim()) return;

    await ctx.inputMenu.run(chip, 'translate', async (still) => {
      try {
        let session = await ensureSession(field);
        if (!still()) return;
        // 没翻译过却调过语气：框里那一版已经不是原文了，以它为新原文。
        if (!session.tones.shown.lang && session.tones.shown.tone) session = newSession(field, await detectLang(snapshot));
        const { shown } = session.tones;
        if (shown.lang && ctx.isSameLanguage(shown.lang, targetLang) && !shown.tone) return;
        const translation = session.tones.translation(targetLang) || await translate(session.tones.text, targetLang);
        if (!still() || !stillWanted(field, snapshot)) return;
        await land(field, session, translation, () => ctx.inputWriteback.write(field, translation));
        session.tones.showTranslation(targetLang, session.seg.text);
      } catch (error) {
        console.warn('Blab Translation: input chip translate/write failed', error);
        // 已经作废的请求（按钮收走了、用户改了字）失败了，按钮上没有它的位置。
        if (still() && chipField === field) chipError = ctx.thrownTranslationMessage(error);
      }
    });
  }

  // ==================== 语气（§4.4） ====================

  // 会话的 toneSource 拿到一版语气之后来这里写：会话还在（框里还是它写下的样子）、
  // 焦点还在、输入法没开着才写。答 false 就是没写，这一版不算显示出来。
  async function writeTone(field, session, text) {
    if (liveSession(field) !== session || !ctx.inputWriteback.hasFocus(field) || inComposition()) return false;
    await land(field, session, text, () => ctx.inputWriteback.replaceAll(field, session.seg.after, text));
    return true;
  }

  /**
   * 调成 tone 并写回（菜单的 pickTone 在芯片这个锚上的 run 里调它）。没翻译过：
   * 用原文的语言改写、替换整段；翻译过：从原文出发、以译文语言重写、只换译文段。
   * 点之前框里的字已经不是会话写下的样子（用户改过译文），就以框里现在的字为新
   * 原文（ensureSession）。
   *
   * 和翻译占同一个锚：结果在路上时芯片是忙的，主体和 ▾ 都点不动 —— 不然一次翻译
   * 会在半路换掉 seg，回来的改写就落进译文段、把它换成别的语言（L1 B1）。回来时
   * 记不记缓存、写不写进框归 toneSource 和 writeTone；用户关了菜单就是不要了，不
   * 替他写。抛出的错误由菜单显示（content-input-menu.js 的 pickTone）。
   */
  async function toneField(field, tone, options) {
    chipError = '';
    const session = await ensureSession(field);
    if (!options.still()) return;
    await session.tones.rewrite(tone, options);
  }

  /** 菜单已经关了才失败的那一次：菜单上没处说，说在芯片上（还贴着这个框的话）。 */
  function showToneError(field, text) {
    if (chipField !== field || ctx.inputMenu.inflight(chip)) return;
    chipError = text;
    paint();
  }

  // ==================== 菜单 ====================

  // 先存、存上了才收起芯片。没存上就抛给菜单：它留着、说没存上
  // （content-input-menu.js 的 pickHideOnSite）。
  async function hideOnSite() {
    await InputChipHosts.hide(location.hostname);
    hideChip();
  }

  function chooseTarget(field, lang) {
    const code = ctx.normalizeTargetLang(lang);
    chosenTarget = code;
    ctx.inputMenu.targetPref.set(code);
    if (chip) chip.dataset.targetLang = code;
    translateField(field, code);
  }

  function openMenu(field) {
    ctx.inputMenu.open({
      anchor: chip,
      targetLang: chip.dataset.targetLang,
      tones: liveSession(field)?.tones || null,
      toneBlocked: !ctx.inputFields.plainEditable(field),
      onTranslate: (lang) => chooseTarget(field, lang),
      onTone: (tone, options) => toneField(field, tone, options),
      onToneError: (text) => showToneError(field, text),
      onHideOnSite: () => hideOnSite(),
    });
  }

  // 点下去：▾ 打开菜单，主体翻译。
  function onChipClick(event) {
    // 按钮是页面 DOM 里的普通节点，页面脚本一句 .click() 就能替用户点它 —— 那一下
    // 会把框里的字发去翻译（可能花额度）、再改写他正在写的内容。只认用户自己的手，
    // 和状态条（content-auto-status.js 的 onBarClick）同一写法。
    if (!event.isTrusted) return;
    const field = chipField;
    if (!field || ctx.inputMenu.inflight(chip)) return;
    if (caret.contains(event.target)) {
      if (ctx.inputMenu.isOpen(chip)) ctx.inputMenu.close();
      else openMenu(field);
      return;
    }
    if (ctx.inputMenu.isOpen(chip)) ctx.inputMenu.close();
    translateField(field, chip.dataset.targetLang || '');
  }

  // ==================== 监听 ====================

  function onFocusIn(e) {
    const field = eventField(e);
    // 焦点进了菜单（它按住了 mousedown，正常不会）：不算离开。
    if (ctx.inputMenu.contains(field)) return;
    if (chipField && chipField !== field) hideChip();
    if (!ctx.inputFields.isWritingField(field)) {
      // 焦点落到别处了。按钮自己不接管焦点（mousedown 被拦住了），所以这就是
      // 「用户走了」。
      if (chipField) hideChip();
      return;
    }
    scheduleEvaluate(field);
  }

  // 点到页面空白处不会有任何东西接管焦点，于是 focusin 根本不响 —— 光靠它，
  // 按钮会留在一个已经失焦的框旁边。
  function onFocusOut(e) {
    if (chipField && eventField(e) === chipField) hideChip();
  }

  function onInput(e) {
    const field = eventField(e);
    if (field === writingField) return;
    if (!ctx.inputFields.isWritingField(field)) return;
    // 结果还在路上用户又改了字：那份结果作废，按钮回到可点，按新字重新判。
    if (chip && chipField === field) {
      ctx.inputMenu.release(chip);
      if (ctx.inputMenu.isOpen(chip)) ctx.inputMenu.close();
    }
    scheduleEvaluate(field);
  }

  function onViewportChange() {
    placeChip();
  }

  function setupInputTranslateChip() {
    // 一律用捕获期的文档级监听：页面上的编辑器常常把自己的事件停在半路，而且
    // 输入框是 SPA 换了又换的东西，逐个绑监听器等于绑不住。
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    document.addEventListener('input', onInput, true);
    // 自己维护模型的编辑器（Lexical 这一类）取消 beforeinput、自己重画，浏览器就
    // 不再发 input —— 只听 input，在这类框里敲多少字按钮都不会醒。
    document.addEventListener('beforeinput', onInput, true);
    document.addEventListener('compositionstart', () => { composing = true; }, true);
    document.addEventListener('compositionend', () => {
      composing = false;
      compositionEndedAt = performance.now();
    }, true);
    document.addEventListener('scroll', onViewportChange, true);
    window.addEventListener('resize', onViewportChange, true);
    // 菜单开着时 Esc 先被菜单收走（content-input-menu.js 的捕获监听更早挂上）。
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && chipField) hideChip();
    }, true);
  }

  ctx.setupInputTranslateChip = setupInputTranslateChip;
  // 开关被关掉时，bootstrap 的存储监听立刻来收走当前这一颗。
  ctx.hideInputTranslateChip = hideChip;
})();
