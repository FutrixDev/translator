// Blab Translation —— 输入框按钮的 ▾ 菜单：翻译 + 调整语气（D-1031/D-1032 §4）。
//
// 输入框旁只有一个按钮「译成 X ▾」（content-input-chip.js）；点主体照旧翻译，
// 点 ▾ 打开这里画的菜单。便签对话框（content-input-dialog.js）的结果区用同一个
// 菜单。这个文件管三件事：
//
// 1. 菜单本身：翻译组（当前目标 ✓、最近 2 个、其他语言…）、语气组（一档 6 个、
//    「更多」3 个、🔒、↻）、底部「在此网站不显示」。选了什么交给打开它的那一处
//    （onTranslate / onTone / onHideOnSite），写进哪个框不归这里。
// 2. 锚上的忙（run / inflight / release）：一个锚一次只做一件事（翻译或调语气），
//    芯片和菜单都看同一个 data-busy。
// 3. 语气（toneSource）：一段原文的各个语气版本、它们的缓存和语气请求。compose()
//    只把契约里的四个字段交给服务工作者（background/compose-client.js），扩展里
//    没有任何语气提示词。错误码在这里变成给人看的一句话；登录、订阅的按钮和别处
//    同一颗（ctx.accountActionButton）。
//
// 判定什么框算写作框归 content-input-fields.js。
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

  // 菜单能说出口的失败：服务端的错误码（compose-client.js 透传上来的，details 是
  // 那份错误本身：plan、limit、action），加上一个本地的 —— 判不出这段字的语言。
  class ToneError extends Error {
    constructor(code, details) {
      super(`tone: ${code}`);
      this.code = code;
      this.details = details || {};
    }
  }

  function replyData(reply) {
    if (reply.ok) return reply.data;
    throw new ToneError(reply.error?.code || 'internal_error', reply.error);
  }

  /** 契约里的四个字段原样交给服务工作者（空 sourceLang 由 compose-client 省掉）。答 `{ text, tone, usage }`。 */
  async function compose(request) {
    return replyData(await ctx.comic.sendMessage({ type: 'COMPOSE_TONE', request }));
  }

  async function signedIn() {
    return replyData(await ctx.comic.sendMessage({ type: 'COMPOSE_STATUS' })).signedIn === true;
  }

  // 错误 → { text, action }。action 是那颗「登录 / 查看套餐」按钮（没有就是空），
  // 哪个拒绝配哪颗只在 background/account-actions.js 的 ACCOUNT_ACTIONS 里定一次，
  // 这里照画 SW 挂上来的 action。每日额度的文案分两句：免费版说升级，付费版说明天。
  function errorNote(error) {
    const { code, details } = error instanceof ToneError ? error : { code: 'internal_error', details: {} };
    const fill = (key, values) => Object.entries(values)
      .reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), t(key));
    switch (code) {
      case 'unauthorized':
        return { text: t('toneLoginRequired'), action: 'signin' };
      case 'daily_limit':
        return {
          text: fill(details.plan === 'free' ? 'toneDailyLimitFree' : 'toneDailyLimitPaid', { limit: details.limit ?? '' }),
          action: details.action || null,
        };
      case 'text_too_long':
        return { text: fill('toneTextTooLong', { limit: details.limit ?? '' }), action: null };
      case 'content_blocked':
        return { text: t('toneContentBlocked'), action: null };
      case 'language_unknown':
        return { text: t('toneLanguageUnknown'), action: null };
      default:
        return { text: t('toneFailed'), action: null };
    }
  }

  /**
   * 一段原文的语气版本（§4.4、§4.6）：芯片的每份框会话、对话框的每个结果各一份。
   * - text：原文。语气永远从它出发，连点两个语气不叠加、不漂移
   * - sourceLang：原文的语言（判不出是空串）；不给就在第一次用到时本地判一次
   * - targetLang：现在显示的已经是哪门语言的译文（对话框）；芯片的会话从原文开始，空
   * - write(text, { lang, tone }) → 写进去了就答 true；答 false 是不写了（框变了、
   *   结果换了），这一版不算显示出来
   * - writeWhileClosed：菜单关了照样写（对话框的结果区是它自己的）。芯片不写：
   *   用户关了菜单就是不要了
   * 缓存按（语言, 语气）记，键只在这里拼：重复选同一项秒回，↻ 才重新要。原文不变，
   * 答案就不变，所以请求回来就记，不管写没写进去。
   */
  function toneSource({ text, sourceLang, targetLang = '', write, writeWhileClosed }) {
    const cache = new Map();
    const key = (lang, tone) => `${lang}\n${tone}`;
    let source = sourceLang;
    // 现在显示的是哪一版：lang 空是原文的语言（没翻译过），tone 空是没调过语气。
    let shown = { lang: targetLang, tone: '' };
    const toneLang = () => shown.lang || source || '';

    async function knownSource() {
      if (source === undefined) source = (await ctx.builtinTranslator?.detectStandaloneLang?.(text.trim())) || '';
      return source;
    }

    return {
      text,
      get sourceLang() { return source || ''; },
      get shown() { return shown; },
      cached: (tone) => !!toneLang() && cache.has(key(toneLang(), tone)),
      translation: (lang) => cache.get(key(lang, '')) || '',
      // 一次翻译写进去了：它就是现在显示的那一版。
      showTranslation(lang, value) {
        cache.set(key(lang, ''), value);
        shown = { lang, tone: '' };
      },
      // 调成 tone：没翻译过用原文的语言改写，翻译过以译文的语言重写。still() 答
      // 这一次还算不算数（锚上的 run 没被放掉）。
      async rewrite(tone, { force, anchor, still }) {
        const before = shown;
        const from = await knownSource();
        const lang = before.lang || from;
        if (!lang) throw new ToneError('language_unknown');
        let value = force ? '' : cache.get(key(lang, tone));
        if (!value) {
          value = (await compose({ text, targetLang: lang, tone, sourceLang: from })).text;
          cache.set(key(lang, tone), value);
        }
        // 等的时候换了一门语言翻译：这一版是给上一门语言的，不写。
        if (shown !== before || !still() || (!writeWhileClosed && !isOpen(anchor))) return;
        if ((await write(value, { lang, tone })) === false) return;
        shown = { lang: before.lang, tone };
      },
    };
  }

  // ==================== 锚上的忙 ====================

  // 一个锚（芯片、对话框的 ▾）一次只做一件事：翻译或调语气。记在锚上不记在某一次
  // 打开的菜单上 —— 关了再开是新的一次，却还是同一个框、同一个结果。每一次 run 领
  // 一个记号：被放掉（用户改了字、芯片收了）或被下一次顶掉之后，晚回来的那一次
  // 收尾不再动锚上的状态，still() 也答 false（D-1043 M6）。
  const runs = new WeakMap();
  const painters = new WeakMap();

  /** 这个锚上在做什么：'translate' | 'tone'，没有就是空串。 */
  function inflight(anchor) {
    return runs.get(anchor)?.kind || '';
  }

  // 锚和（贴着它开着的）菜单上的 data-busy 只在这里写，然后请锚的主人重画自己。
  function showBusy(anchor) {
    const kind = inflight(anchor);
    if (kind) anchor.dataset.busy = kind;
    else delete anchor.dataset.busy;
    if (isOpen(anchor)) {
      if (kind) menu.dataset.busy = kind;
      else delete menu.dataset.busy;
    }
    painters.get(anchor)?.();
  }

  async function run(anchor, kind, work) {
    if (runs.has(anchor)) throw new Error(`input menu: ${inflight(anchor)} is still running on this anchor`);
    const token = { kind };
    runs.set(anchor, token);
    showBusy(anchor);
    const still = () => runs.get(anchor) === token;
    try {
      return await work(still);
    } finally {
      if (still()) {
        runs.delete(anchor);
        showBusy(anchor);
      }
    }
  }

  /** 放掉这个锚上正在做的事：它回来时 still() 答 false，什么都不写。 */
  function release(anchor) {
    if (runs.delete(anchor)) showBusy(anchor);
  }

  /** 锚上的忙变了就调 paint（芯片据此重画标签）。 */
  function onBusyChange(anchor, paint) {
    painters.set(anchor, paint);
  }

  // ==================== 摆放 ====================

  // 芯片和菜单共用的摆法：贴在锚的外侧、右边对齐，下面放不下翻到上面，夹进视口。
  // 算术归 ctx.placeBeside（content-utils.js，几个浮层共用的那一份）。
  function placeBeside(node, rect) {
    const width = node.offsetWidth || 0;
    const { left, top } = ctx.placeBeside({ width, height: node.offsetHeight || 0 }, rect, {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      gap: GAP,
      margin: GAP,
      x: rect.right - width,
    });
    node.style.top = `${top}px`;
    node.style.left = `${left}px`;
  }

  // ==================== 菜单 ====================

  let menu = null;
  let current = null;

  function opened() {
    return !!(menu && menu.isConnected && current);
  }

  function contains(node) {
    return !!(menu && node && menu.contains(node));
  }

  /** 菜单开着、而且是贴着 anchor 开的（芯片收起时只收自己开的那一个）。 */
  function isOpen(anchor) {
    return opened() && current.state.anchor === anchor;
  }

  function close() {
    current = null;
    if (!menu) return;
    delete menu.dataset.busy;
    menu.remove();
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
    node.setAttribute('aria-checked', String(state.tones?.shown.tone === tone));
    if (state.toneBlocked) node.setAttribute('aria-disabled', 'true');
    if (!state.toneBlocked && state.tones?.cached(tone)) {
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
    placeBeside(menu, anchor.getBoundingClientRect());
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
   * - tones：这段原文的 toneSource（打 ✓ 的语气、有缓存才画的 ↻），还没有就是 null
   * - toneBlocked：含格式的 contenteditable，语气项置灰
   * - onTranslate(lang)
   * - onTone(tone, { force, anchor, still }) → Promise：在锚上的 run 里跑，still()
   *   答这一次还算不算数
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
    const busy = inflight(state.anchor);
    if (busy) node.dataset.busy = busy;
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
    const { anchor } = state;
    if (inflight(anchor)) return;
    if (state.toneBlocked) {
      showNote(session, t('toneFormattedUnsupported'), null);
      return;
    }
    const target = menu.querySelector(`[data-tone="${tone}"]`);
    session.note.hidden = true;
    target?.setAttribute('aria-busy', 'true');
    try {
      const sent = await run(anchor, 'tone', async (still) => {
        if (!(await signedInNow(session))) return false;
        await state.onTone(tone, { force, anchor, still });
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
      if (error instanceof ToneError && error.code === 'unauthorized') session.signedIn = Promise.resolve(false);
      showNote(session, text, action);
      if (action === 'signin') menu.querySelector('.ai-translator-input-menu-lock').hidden = false;
    } finally {
      target?.removeAttribute('aria-busy');
    }
  }

  // 「在此网站不显示」：存上了，芯片自己收起（连同菜单）；没存上，菜单留着说出来。
  // 错误在这里接住、不再往上抛，就在这里记一条。存的时候不占锚：它不写框。
  async function pickHideOnSite(session) {
    if (inflight(session.state.anchor)) return;
    session.note.hidden = true;
    try {
      await session.state.onHideOnSite();
      if (current === session) close();
    } catch (error) {
      console.error('Blab Translation: saving the hide-input-chip site failed', error);
      if (current === session) showNote(session, t('customRuleSaveFailed'), null);
    }
  }

  function onMenuClick(event) {
    // 页面脚本一句 .click() 就能替用户点它：可能花额度、改写他正在写的字。只认人手。
    if (!event.isTrusted) return;
    const session = current;
    if (!session) return;
    // 锚上还在翻译或调语气：别的项都不接（菜单整个标着 data-busy）。
    if (inflight(session.state.anchor)) return;
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
      pickHideOnSite(session);
    }
  }

  // 点到菜单和它的锚之外就收起；Esc 先收菜单，不让同一下 Esc 再关掉芯片或对话框。
  // 捕获期、在这个文件装载时就挂上，比芯片和对话框的 Esc 监听都早。
  document.addEventListener('mousedown', (event) => {
    if (!opened()) return;
    const target = event.composedPath ? event.composedPath()[0] : event.target;
    if (contains(target) || current.state.anchor?.contains?.(target)) return;
    close();
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing || !opened()) return;
    event.stopImmediatePropagation();
    close();
  }, true);
  // 滚动、改窗口大小时锚会动（芯片自己听同一个事件再摆，对话框的 ▾ 随结果区滚）。
  // 菜单要等锚落定再摆：同一个事件里先跑的监听读到的是锚上一拍的位置，滚一下就
  // 落后一下。所以只记一笔，到这一帧画之前（requestAnimationFrame，排在这一帧所有
  // scroll 监听之后）摆一次。
  let placeQueued = false;
  function placeSoon(event) {
    if (!opened() || placeQueued || (event.type === 'scroll' && contains(event.target))) return;
    placeQueued = true;
    requestAnimationFrame(() => {
      placeQueued = false;
      if (opened()) placeMenu(current.state.anchor);
    });
  }
  window.addEventListener('resize', placeSoon, true);
  document.addEventListener('scroll', placeSoon, true);

  ctx.inputMenu = {
    targetPref,
    translateLabel,
    toneSource,
    run,
    inflight,
    release,
    onBusyChange,
    placeBeside,
    open,
    close,
    isOpen,
    contains,
  };
})();
