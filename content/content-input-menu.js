// Blab Translation —— 输入框按钮的 ▾ 菜单：翻译 + 调整语气（D-1031/D-1032 §4）。
//
// 输入框旁只有一个按钮「译成 X ▾」（content-input-chip.js）；点主体照旧翻译，
// 点 ▾ 打开这里画的菜单。便签对话框（content-input-dialog.js）的结果区用同一个
// 菜单。这个文件只管三件事，免得芯片文件继续膨胀：
//
// 1. 菜单本身：翻译组（当前目标 ✓、最近 2 个、其他语言…）、语气组（一档 6 个、
//    「更多」3 个、🔒、↻）、底部「在此网站不显示」。选了什么交给打开它的那一处
//    （onTranslate / onTone / onHideOnSite），写进哪个框不归这里。
// 2. 判定：什么框算写作框（isWritingField）、多长才出按钮（longEnough）、
//    contenteditable 是不是纯文本（plainEditable，含格式时语气置灰）。
// 3. 语气请求：compose() 只把契约里的四个字段交给服务工作者
//    （background/compose-client.js），扩展里没有任何语气提示词。错误码在这里变成
//    给人看的一句话；登录、订阅的按钮和别处同一颗（ctx.accountActionButton）。
//
// 未登录：打开菜单时只问服务工作者「存没存 token」（COMPOSE_STATUS，不出机器），
// 没有就给语气组带 🔒；点语气才说「登录后可调整语气」，一个请求都不发。
(function () {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const t = ctx.t;
  const Tones = globalThis.Tones;
  if (!Tones) throw new Error('content-input-menu.js 要先装 shared/tones.js');

  const MENU_ID = 'ai-translator-input-menu';
  const RECENT_IN_MENU = 2;
  const GAP = 4;

  // ==================== 判定 ====================

  // 页面用 autocomplete 说了这个框装的是登录名、验证码、卡号：没有语言可言。
  // autocomplete 是一串记号（`shipping cc-number`、`section-a username`），逐个看。
  const NON_PROSE_AUTOCOMPLETE = new Set(['one-time-code', 'username', 'current-password', 'new-password']);
  const TEXTUAL_INPUT_TYPES = new Set(['text']);
  // 搜索框、联想框：敲的是查询词，不是要发给别人读的话（§4.2）。
  const QUERY_ROLES = new Set(['searchbox', 'combobox']);

  function isCredentialField(el) {
    const tokens = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
    return tokens.some((token) => token.startsWith('cc-') || NON_PROSE_AUTOCOMPLETE.has(token));
  }

  function isOurNode(el) {
    return !!el.closest('.ai-translator-popup, [id^="ai-translator"], [class*="ai-translator"]');
  }

  /**
   * 写作框（§4.2）：textarea、contenteditable、type=text（或没写 type）的单行框。
   * 排除 type=search、role=searchbox/combobox、带联想列表的单行框
   * （aria-autocomplete）和凭证框。aria-autocomplete 只对 <input> 算数：x.com 的
   * 发帖框（Draft）带 aria-autocomplete=list —— 它的联想是 @提及，框本身是写作框。
   */
  function isWritingField(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.disabled || el.readOnly) return false;
    if (isOurNode(el)) return false;
    if (isCredentialField(el)) return false;
    if (QUERY_ROLES.has((el.getAttribute('role') || '').toLowerCase())) return false;

    const tag = el.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') {
      if (!TEXTUAL_INPUT_TYPES.has((el.type || 'text').toLowerCase())) return false;
      const autocomplete = (el.getAttribute('aria-autocomplete') || 'none').toLowerCase();
      return autocomplete === 'none';
    }
    return el.isContentEditable === true;
  }

  const CJK_CHARS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
  const MIN_WORDS = 3;
  const MIN_CJK_CHARS = 10;

  /** 够不够长：至少 3 个词（含字母或数字的那种），或至少 10 个中日韩字（§4.2）。 */
  function longEnough(text) {
    const value = String(text || '');
    const cjk = value.match(CJK_CHARS);
    if (cjk && cjk.length >= MIN_CJK_CHARS) return true;
    const words = value.trim().split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word));
    return words.length >= MIN_WORDS;
  }

  // 纯文本 contenteditable 里只会出现的元素：换行和段落。编辑器自己的包装
  // （Draft 的 div/span、Lexical 的 p/span）也只是这几种。
  const PLAIN_TAGS = new Set(['BR', 'P', 'DIV', 'SPAN']);

  function styledInline(el) {
    const style = el.style;
    if (!style) return false;
    const weight = style.fontWeight;
    return weight === 'bold' || weight === 'bolder' || Number(weight) >= 600
      || style.fontStyle === 'italic'
      || /underline|line-through/.test(style.textDecoration || style.textDecorationLine || '');
  }

  /**
   * contenteditable 是不是只有纯文本（§4.4）：文本节点和 <br>/段落。链接、
   * @提及（contenteditable=false 的小块）、图片、加粗斜体都算格式 —— 整段替换会把
   * 它们抹成纯字，所以语气项置灰，翻译照常。原生框总是纯文本。
   */
  function plainEditable(field) {
    if (!field || field.tagName === 'TEXTAREA' || field.tagName === 'INPUT') return true;
    for (const el of field.querySelectorAll('*')) {
      if (!PLAIN_TAGS.has(el.tagName)) return false;
      if (el.getAttribute('contenteditable') === 'false') return false;
      if (styledInline(el)) return false;
    }
    return true;
  }

  // ==================== 默认目标（按设备记） ====================

  // 「译成」默认目标，芯片和便签对话框是同一个概念，所以只有这一个键（§4.3）：
  // 在本地不在 sync —— 这是一台设备的习惯，写进 sync 会跨设备改掉别处的目标。
  // 在设置里改了目标语言就清掉它：那是更明确的选择。读、settled、跟随别的标签都归
  // ctx.localPref（content/content-local-pref.js）。
  const targetPref = ctx.localPref('inputTargetLang', { parse: (stored) => (typeof stored === 'string' ? stored : '') });

  chrome.storage.onChanged.addListener((changes, namespace) => {
    // 每个 frame 都跑这个监听；只有记着语言的那个才真写（localPref 的 set 跳过同值）。
    if (namespace === 'sync' && changes.targetLang) targetPref.set('');
  });

  // ==================== 语气请求 ====================

  // 菜单能说出口的失败：服务端的错误码（compose-client.js 透传上来的），加上两个
  // 本地的 —— 判不出这段字的语言、写回时框已经不是那个样子。
  function toneError(code, details) {
    const error = new Error(`tone: ${code}`);
    error.tone = Object.assign({ code }, details);
    return error;
  }

  /** 只发契约里的四个字段（sourceLang 可省）。答 `{ text, tone, usage }`，失败抛 toneError。 */
  async function compose({ text, targetLang, tone, sourceLang }) {
    const request = { text, targetLang, tone };
    if (sourceLang) request.sourceLang = sourceLang;
    const reply = await ctx.comic.sendMessage({ type: 'COMPOSE_TONE', request });
    if (reply.ok) return reply.data;
    throw toneError(reply.error?.code || 'internal_error', reply.error);
  }

  async function signedIn() {
    const reply = await ctx.comic.sendMessage({ type: 'COMPOSE_STATUS' });
    if (!reply.ok) throw toneError(reply.error?.code || 'internal_error', reply.error);
    return reply.data.signedIn === true;
  }

  // 错误码 → { text, action }。action 是那颗「登录 / 查看套餐」按钮（没有就是空），
  // 哪个拒绝配哪颗只在 background/account-actions.js 的 ACCOUNT_ACTIONS 里定一次，
  // 这里照画 SW 挂上来的 action。每日额度的文案分两句：免费版说升级，付费版说明天。
  function errorNote(error) {
    const info = error?.tone || { code: 'internal_error' };
    const fill = (key, values) => Object.entries(values)
      .reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), t(key));
    switch (info.code) {
      case 'unauthorized':
        return { text: t('toneLoginRequired'), action: 'signin' };
      case 'daily_limit':
        return {
          text: fill(info.plan === 'free' ? 'toneDailyLimitFree' : 'toneDailyLimitPaid', { limit: info.limit ?? '' }),
          action: info.action || null,
        };
      case 'text_too_long':
        return { text: fill('toneTextTooLong', { limit: info.limit ?? '' }), action: null };
      case 'content_blocked':
        return { text: t('toneContentBlocked'), action: null };
      case 'language_unknown':
        return { text: t('toneLanguageUnknown'), action: null };
      case 'formatted_field':
        return { text: t('toneFormattedUnsupported'), action: null };
      default:
        return { text: t('toneFailed'), action: null };
    }
  }

  // ==================== 菜单 ====================

  let menu = null;
  let current = null;
  // 正在等结果的锚（芯片、对话框的 ▾）：同一个锚一次只走一个语气请求或一次保存。
  // 记在锚上不记在这一次打开上 —— 关了再开是新的一次，却还是同一个框、同一个结果。
  const busyAnchors = new WeakSet();

  function isOpen() {
    return !!(menu && menu.isConnected && current);
  }

  function contains(node) {
    return !!(menu && node && menu.contains(node));
  }

  /** 菜单开着、而且是贴着 anchor 开的（芯片收起时只收自己开的那一个）。 */
  function anchoredTo(anchor) {
    return isOpen() && current.state.anchor === anchor;
  }

  function close() {
    current = null;
    if (menu) menu.remove();
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function item(className, text, attrs) {
    const node = el('div', `ai-translator-input-menu-item ${className}`.trim(), text);
    node.setAttribute('role', 'menuitem');
    for (const [name, value] of Object.entries(attrs || {})) node.setAttribute(name, value);
    return node;
  }

  // 「译成 X」这一句：芯片的标签和菜单里的语言项是同一句。
  const translateLabel = (lang) => t('inputChipTranslateTo').replace('{lang}', ctx.languageName(lang, { inSentence: true }));

  function translateGroup(state) {
    const group = el('div', 'ai-translator-input-menu-group');
    group.appendChild(el('div', 'ai-translator-input-menu-title', t('menuTranslate')));
    const shown = ctx.normalizeTargetLang(state.targetLang);
    const langItem = (lang, extra) => {
      const node = item(`ai-translator-input-menu-lang ${extra || ''}`, translateLabel(lang), { 'data-lang': lang });
      node.setAttribute('role', 'menuitemradio');
      node.setAttribute('aria-checked', String(lang === shown));
      return node;
    };
    group.appendChild(langItem(shown, 'is-current'));
    const recent = ctx.recentTargetLangs()
      .map((lang) => ctx.normalizeTargetLang(lang))
      .filter((lang, at, all) => lang !== shown && all.indexOf(lang) === at)
      .slice(0, RECENT_IN_MENU);
    for (const lang of recent) group.appendChild(langItem(lang));
    group.appendChild(item('ai-translator-input-menu-other', t('menuOtherLanguages'), { 'data-action': 'other' }));
    const all = el('div', 'ai-translator-input-menu-langs');
    all.hidden = true;
    for (const option of TargetLang.options(ctx.uiLanguage())) {
      const node = item('ai-translator-input-menu-lang', option.label, { 'data-lang': option.value });
      node.setAttribute('role', 'menuitemradio');
      node.setAttribute('aria-checked', String(option.value === shown));
      all.appendChild(node);
    }
    group.appendChild(all);
    return group;
  }

  function toneItem(state, tone) {
    const node = item('ai-translator-input-menu-tone', t(Tones.labelKey(tone)), { 'data-tone': tone });
    node.setAttribute('role', 'menuitemradio');
    node.setAttribute('aria-checked', String(state.shownTone === tone));
    if (state.toneBlocked) node.setAttribute('aria-disabled', 'true');
    if (!state.toneBlocked && state.isCached && state.isCached(tone)) {
      const again = el('span', 'ai-translator-input-menu-regenerate', '↻');
      again.setAttribute('role', 'button');
      again.dataset.regenerate = tone;
      again.title = t('toneRegenerate');
      again.setAttribute('aria-label', `${t('toneRegenerate')} · ${t(Tones.labelKey(tone))}`);
      node.appendChild(again);
    }
    return node;
  }

  function toneGroup(state) {
    const group = el('div', 'ai-translator-input-menu-group ai-translator-input-menu-tones');
    const title = el('div', 'ai-translator-input-menu-title', t('toneGroup'));
    const lock = el('span', 'ai-translator-input-menu-lock', '🔒');
    lock.hidden = true;
    lock.setAttribute('aria-label', t('toneLoginRequired'));
    title.appendChild(lock);
    group.appendChild(title);
    const grid = el('div', 'ai-translator-input-menu-tone-grid');
    for (const tone of Tones.PRIMARY) grid.appendChild(toneItem(state, tone));
    group.appendChild(grid);
    const more = el('div', 'ai-translator-input-menu-more');
    more.appendChild(el('span', 'ai-translator-input-menu-more-label', t('toneMore')));
    for (const tone of Tones.MORE) more.appendChild(toneItem(state, tone));
    group.appendChild(more);
    if (state.toneBlocked) {
      group.appendChild(el('div', 'ai-translator-input-menu-hint', t('toneFormattedUnsupported')));
    }
    return group;
  }

  function placeMenu(anchor) {
    if (!menu || !anchor || !anchor.isConnected) return;
    const rect = anchor.getBoundingClientRect();
    const width = menu.offsetWidth || 0;
    const height = menu.offsetHeight || 0;
    const below = rect.bottom + GAP;
    const top = below + height + GAP > window.innerHeight
      ? Math.max(GAP, rect.top - height - GAP)
      : below;
    menu.style.top = `${top}px`;
    menu.style.left = `${Math.max(GAP, Math.min(window.innerWidth - width - GAP, rect.right - width))}px`;
  }

  function ensureMenu() {
    if (menu) return menu;
    menu = el('div');
    menu.id = MENU_ID;
    menu.setAttribute('role', 'menu');
    // 和芯片同一条：按下去的那一刻按住焦点，输入框不失焦。捕获期：登录/订阅那颗
    // 按钮（ctx.accountActionButton）自己在 mousedown 上 stopPropagation，冒泡期
    // 的监听轮不到它。
    menu.addEventListener('mousedown', (event) => event.preventDefault(), true);
    menu.addEventListener('click', onMenuClick);
    return menu;
  }

  /**
   * 打开菜单。`state`：
   * - anchor：贴着谁（芯片、对话框结果区的 ▾）
   * - targetLang：翻译组打 ✓ 的那门语言
   * - shownTone：框里现在是哪个语气的版本（打 ✓），没有就是空
   * - toneBlocked：含格式的 contenteditable，语气项置灰
   * - isCached(tone)：这一项有没有缓存（有才画 ↻）
   * - onTranslate(lang)
   * - onTone(tone, { force, menuOpen }) → Promise：menuOpen() 答这一次打开还在不在
   * - onToneError(text)：语气请求失败时菜单已经关了，由锚的主人找地方说
   * - onHideOnSite() → Promise（不给就不画底部那一项）：失败时菜单留着说出来
   * 每次打开都重画：最近语言、登录状态、缓存都可能变了。
   */
  function open(state) {
    close();
    const node = ensureMenu();
    node.replaceChildren();
    node.appendChild(translateGroup(state));
    node.appendChild(el('div', 'ai-translator-input-menu-sep'));
    node.appendChild(toneGroup(state));
    const note = el('div', 'ai-translator-input-menu-note');
    note.setAttribute('role', 'status');
    note.hidden = true;
    node.appendChild(note);
    if (state.onHideOnSite) {
      node.appendChild(el('div', 'ai-translator-input-menu-sep'));
      node.appendChild(item('ai-translator-input-menu-hide', t('inputChipHideOnSite'), { 'data-action': 'hide-site' }));
    }
    document.body.appendChild(node);
    const session = { state, note, signedIn: signedIn() };
    current = session;
    if (busyAnchors.has(state.anchor)) node.dataset.busy = 'true';
    else delete node.dataset.busy;
    placeMenu(state.anchor);
    session.signedIn.then((yes) => {
      if (current === session) node.querySelector('.ai-translator-input-menu-lock').hidden = yes;
    }, (error) => {
      // 问不到登录状态：先画上锁（不知道能不能用）。点语气时 pickTone 会真的再问
      // 一次；那一次还失败，就说「语气调整失败」，不冒充成「没登录」。
      console.warn('Blab Translation: compose status failed', error);
      if (current === session) node.querySelector('.ai-translator-input-menu-lock').hidden = false;
    });
    return session;
  }

  function showNote(session, text, action) {
    const { note } = session;
    note.replaceChildren(el('span', 'ai-translator-input-menu-note-text', text));
    const button = ctx.accountActionButton(action, {
      className: 'ai-translator-input-menu-action',
      onSignedIn: () => {
        if (current !== session) return;
        session.signedIn = Promise.resolve(true);
        menu.querySelector('.ai-translator-input-menu-lock').hidden = true;
        note.hidden = true;
      },
    });
    if (button) note.appendChild(button);
    note.hidden = false;
    placeMenu(session.state.anchor);
  }

  function showLoginNote(session) {
    showNote(session, t('toneLoginRequired'), 'signin');
  }

  // 这个锚上的一次等待：菜单（这一次打开的话）和点中的那一项标上 busy，结束摘掉。
  async function whileBusy(session, target, work) {
    const { anchor } = session.state;
    busyAnchors.add(anchor);
    if (current === session) menu.dataset.busy = 'true';
    if (target) target.dataset.busy = 'true';
    try {
      return await work();
    } finally {
      busyAnchors.delete(anchor);
      if (current === session) delete menu.dataset.busy;
      if (target) delete target.dataset.busy;
    }
  }

  // 登录状态：打开菜单时问的那一次失败了，就再问一次（SW 可能刚醒）。还失败就抛，
  // 由调用方当一次普通的失败显示。
  async function signedInNow(session) {
    try {
      return await session.signedIn;
    } catch {
      session.signedIn = signedIn();
      return session.signedIn;
    }
  }

  async function pickTone(session, tone, force) {
    const { state } = session;
    if (busyAnchors.has(state.anchor)) return;
    if (state.toneBlocked) {
      showNote(session, t('toneFormattedUnsupported'), null);
      return;
    }
    const target = menu.querySelector(`[data-tone="${tone}"]`);
    session.note.hidden = true;
    try {
      const sent = await whileBusy(session, target, async () => {
        if (!(await signedInNow(session))) return false;
        if (current === session) await state.onTone(tone, { force, menuOpen: () => current === session });
        return true;
      });
      if (current !== session) return;
      if (sent) close();
      else showLoginNote(session);
    } catch (error) {
      // 语气这条路上只在这里记一次（SW 不记 compose 的失败，见 compose-client.js）。
      console.warn('Blab Translation: tone rewrite failed', error);
      const { text, action } = errorNote(error);
      if (current !== session) {
        state.onToneError?.(text);
        return;
      }
      if (error?.tone?.code === 'unauthorized') session.signedIn = Promise.resolve(false);
      showNote(session, text, action);
      if (action === 'signin') menu.querySelector('.ai-translator-input-menu-lock').hidden = false;
    }
  }

  // 「在此网站不显示」：存上了，芯片自己收起（连同菜单）；没存上，菜单留着说出来。
  // CustomRules 认得的错误（customRuleSaveFailed 之类）在它换键的那一层已经记过日志；
  // 表外的（扩展上下文失效）在这里接住，就在这里记一条 —— 和拾取器同一个分法。
  async function pickHideOnSite(session, target) {
    if (busyAnchors.has(session.state.anchor)) return;
    session.note.hidden = true;
    try {
      await whileBusy(session, target, () => session.state.onHideOnSite());
      if (current === session) close();
    } catch (error) {
      const key = CustomRules.userErrorKey(error);
      if (!key) console.error('Blab Translation: saving the hide-input-chip site rule failed', error);
      if (current === session) showNote(session, t(key || 'customRuleSaveFailed'), null);
    }
  }

  function onMenuClick(event) {
    // 页面脚本一句 .click() 就能替用户点它：可能花额度、改写他正在写的字。只认人手。
    if (!event.isTrusted) return;
    const session = current;
    if (!session) return;
    // 等结果的时候别的项都不接：译成别的语言会被芯片的 pending 静静挡掉，看着像没反应。
    if (busyAnchors.has(session.state.anchor)) return;
    const regenerate = event.target.closest('[data-regenerate]');
    if (regenerate) {
      pickTone(session, regenerate.dataset.regenerate, true);
      return;
    }
    const tone = event.target.closest('[data-tone]');
    if (tone) {
      if (tone.getAttribute('aria-disabled') === 'true') {
        showNote(session, t('toneFormattedUnsupported'), null);
        return;
      }
      pickTone(session, tone.dataset.tone, false);
      return;
    }
    const lang = event.target.closest('[data-lang]');
    if (lang) {
      close();
      session.state.onTranslate(lang.dataset.lang);
      return;
    }
    const action = event.target.closest('[data-action]');
    if (!action) return;
    if (action.dataset.action === 'other') {
      const list = menu.querySelector('.ai-translator-input-menu-langs');
      list.hidden = !list.hidden;
      action.setAttribute('aria-expanded', String(!list.hidden));
      placeMenu(session.state.anchor);
    } else if (action.dataset.action === 'hide-site') {
      pickHideOnSite(session, action);
    }
  }

  // 点到菜单和它的锚之外就收起；Esc 先收菜单，不让同一下 Esc 再关掉芯片或对话框。
  // 捕获期、在这个文件装载时就挂上，比芯片和对话框的 Esc 监听都早。
  document.addEventListener('mousedown', (event) => {
    if (!isOpen()) return;
    const target = event.composedPath ? event.composedPath()[0] : event.target;
    if (contains(target) || current.state.anchor?.contains?.(target)) return;
    close();
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing || !isOpen()) return;
    event.stopImmediatePropagation();
    close();
  }, true);
  // 滚动、改窗口大小时锚会动（芯片自己听同一个事件再摆，对话框的 ▾ 随结果区滚）。
  // 菜单要等锚落定再摆：同一个事件里先跑的监听读到的是锚上一拍的位置，滚一下就
  // 落后一下。所以只记一笔，到这一帧画之前（requestAnimationFrame，排在这一帧所有
  // scroll 监听之后）摆一次。
  let placeQueued = false;
  function placeSoon(event) {
    if (!isOpen() || placeQueued || (event.type === 'scroll' && contains(event.target))) return;
    placeQueued = true;
    requestAnimationFrame(() => {
      placeQueued = false;
      if (isOpen()) placeMenu(current.state.anchor);
    });
  }
  window.addEventListener('resize', placeSoon, true);
  document.addEventListener('scroll', placeSoon, true);

  ctx.inputMenu = {
    isWritingField,
    longEnough,
    plainEditable,
    targetPref,
    translateLabel,
    compose,
    toneError,
    open,
    close,
    isOpen,
    anchoredTo,
    contains,
  };
})();
