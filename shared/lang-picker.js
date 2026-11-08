// 目标语言下拉的唯一实现：划词卡、输入框对话框（内容脚本）、设置页、工具栏弹窗
// 四处共用这一份。曾经只有内容脚本那两处是这个带筛选框的菜单，设置页是一个原生
// <select>：同一件事两个样子，七十多门语言的长表在设置页里还没法搜。
//
// 两层：
//   renderMenu(menu, …)    把菜单画进 menu，返回这一次画出来的菜单的控制器
//                          （筛选、看得见的选项、当前项与方向键/回车）；
//   attachDropdown(root, …) 接上触发按钮：开、关、点外面关、Escape、焦点回到哪里，
//                          和当前值（触发按钮上写的那一门）。
// 菜单只在打开时画，每次打开重画：「最近使用」一组和「仅 AI」标记都按那一刻算。
//
// 不直接碰 chrome.*，也不认识哪个宿主：最近用过哪些、哪门要标「仅 AI」、文案的查法
// （t），都由调用处传进来。「最近使用」存在 chrome.storage.local 的 RECENT_KEY 下，
// 由内容脚本在派发翻译时写（content/content-language.js）；parseRecent 是读它的唯一
// 口径，watchRecent(storage) 给只读它的扩展页面用（设置页、工具栏弹窗）。节点的类名四处一样（ai-translator-lang-*），样子由宿主的样式表画：
// 内容脚本是 content/css/popup.css，扩展页面是 shared/lang-picker.css。
//
// 装载顺序：要排在 shared/target-lang.js 后面（选项和名字都问它）。
(function (root) {
  'use strict';

  const TargetLang = root.TargetLang;
  if (!TargetLang) throw new Error('lang-picker.js 要先装 shared/target-lang.js');

  const ITEM = '.ai-translator-lang-item';
  const FILTER = '.ai-translator-lang-filter';

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // 一门语言能用哪些名字找到：界面语言下的名字（菜单上写的那个）、英文名、它自己的
  // 名字（日本語）、语言码。英文名和自称与界面语言无关，算一次记下。全部小写，
  // 筛选时拿小写的查询去比。
  const fixedNames = new Map();
  function matchNames(option) {
    let fixed = fixedNames.get(option.value);
    if (!fixed) {
      fixed = [TargetLang.nameOf(option.value, 'en'), TargetLang.autonym(option.value), option.value];
      fixedNames.set(option.value, fixed);
    }
    return [...new Set([option.label, ...fixed].map((name) => name.toLocaleLowerCase()))];
  }

  // 查询和一门语言的名字有多贴：0 某个名字就是它（ja、日本語），1 某个名字以它开头，
  // 2 名字里某个词以它开头（Chinese (Traditional) 里的 trad），3 只是包含它；
  // -1 对不上。「ja」要先给日语，不能按字母序先给 Azerbaijani。
  function matchRank(names, query) {
    if (names.includes(query)) return 0;
    if (names.some((name) => name.startsWith(query))) return 1;
    if (names.some((name) => name.split(/[\s()\-（）]+/).some((word) => word.startsWith(query)))) return 2;
    if (names.some((name) => name.includes(query))) return 3;
    return -1;
  }

  /**
   * 把目标语言菜单画进 `menu`，返回这一次画出来的菜单的控制器。
   *
   * 菜单总是两组：先「最近使用」（data-recent="1"），再「全部语言」全表；全表不剔除
   * 最近项，按字母找的人照样找得到。最近项是全表选项的子集引用，不是第二份语言清单：
   * 认不出的码直接不出。一个认得出的都没有时，最近组只放当前语言——只是显示，所以第一
   * 次打开就看得到这一组在哪。两组上面是一个筛选框，菜单底下是一句「没有匹配的语言」
   * （平时藏着）。
   *
   * 「仅 AI」标记只进 data-tag，由样式表的 ::after 画：选中时触发按钮拿 item.textContent
   * 当标签，写进文字就会跟着进标签。
   *
   * @param {Element} menu
   * @param {{
   *   selected: string,            规范码（SUPPORTED 之一），标成 is-selected
   *   uiLang: string,              名字和排序按它
   *   recent?: string[],           最近用过的规范码，最近在前
   *   aiOnly?: (code) => boolean,  为真的那几门带 t(langAiOnly) 标记
   *   t: (key) => string,          宿主的文案查法（langFilter、langRecent、langAll、
   *                                langNoMatch，有 aiOnly 时还有 langAiOnly）
   * }} opts
   */
  function renderMenu(menu, { selected, uiLang, recent = [], aiOnly = null, t }) {
    const labels = {
      filter: t('langFilter'),
      recent: t('langRecent'),
      all: t('langAll'),
      noMatch: t('langNoMatch'),
    };
    const aiOnlyTag = aiOnly ? escapeHtml(t('langAiOnly')) : '';
    const item = (option, isRecent) => {
      const isSelected = option.value === selected ? ' is-selected' : '';
      const tag = aiOnly && aiOnly(option.value) ? ` data-tag="${aiOnlyTag}"` : '';
      const mark = isRecent ? ' data-recent="1"' : '';
      return `<button class="ai-translator-lang-item${isSelected}" type="button" data-lang="${option.value}"${mark}${tag}>${escapeHtml(option.label)}</button>`;
    };
    const options = TargetLang.options(uiLang);
    const known = (codes) => codes
      .map((code) => options.find((option) => option.value === code))
      .filter(Boolean);
    const stored = known(recent);
    const recentOptions = stored.length ? stored : known([selected]);
    const group = (label, which) =>
      `<div class="ai-translator-lang-group" role="presentation" data-group="${which}">${escapeHtml(label)}</div>`;
    const filterLabel = escapeHtml(labels.filter);
    menu.innerHTML = `<input class="ai-translator-lang-filter" type="text" placeholder="${filterLabel}" aria-label="${filterLabel}" autocomplete="off" spellcheck="false">`
      + group(labels.recent, 'recent')
      + recentOptions.map((option) => item(option, true)).join('')
      + group(labels.all, 'all')
      + options.map((option) => item(option, false)).join('')
      + `<div class="ai-translator-lang-empty" role="status" hidden>${escapeHtml(labels.noMatch)}</div>`;
    return menuController(menu, options.map(matchNames));
  }

  // 一次画出来的菜单的控制器。`names[i]` 是全表第 i 项的名字（与画出来的顺序一致）。
  // 节点只在第一次用到时去找：只想看画出了什么的人（单测）不必有一棵 DOM。
  //
  // 筛选不挪节点：全表项按贴合度写 CSS order（菜单是一列 flex），清空查询就把 order
  // 去掉，回到画出来的顺序。有查询时只在全表里找、每门语言只出一次：最近组是全表的
  // 重复，连标题一起藏起；同一档保持原序。一项都没有时露出「没有匹配的语言」，「全部
  // 语言」的标题也藏起。
  //
  // 当前项（is-active）是上下键挑到的那一项：没有当前项时向下从第一项起、向上从最后
  // 一项起，到头就停。筛选框里的回车选当前项，没有就选第一个看得见的；Tab 聚焦到某一项
  // 上按的回车不归它：那是按下这个按钮，浏览器照常点它，选的就是它。
  function menuController(menu, names) {
    let dom = null;
    const nodes = () => dom || (dom = {
      filter: menu.querySelector(FILTER),
      empty: menu.querySelector('.ai-translator-lang-empty'),
      recentGroup: menu.querySelector('.ai-translator-lang-group[data-group="recent"]'),
      allGroup: menu.querySelector('.ai-translator-lang-group[data-group="all"]'),
      recent: [...menu.querySelectorAll(`${ITEM}[data-recent]`)],
      full: [...menu.querySelectorAll(`${ITEM}:not([data-recent])`)],
    });
    // 有查询时按显示顺序排好的匹配项；没有查询时为 null，看得见的就是画出来的全部。
    let matches = null;
    let active = null;

    // 只动菜单自己的 scrollTop，不用 scrollIntoView（那会连宿主页面一起滚）。筛选框粘在
    // 菜单顶上，被它挡住的那一截不算露出来：看得见的一段从筛选框底边到菜单可视区底边，
    // 都按屏幕上量到的位置算。
    const keepInView = (item) => {
      const box = item.getBoundingClientRect();
      const top = nodes().filter.getBoundingClientRect().bottom;
      const bottom = menu.getBoundingClientRect().top + menu.clientTop + menu.clientHeight;
      if (box.top < top) menu.scrollTop -= top - box.top;
      else if (box.bottom > bottom) menu.scrollTop += box.bottom - bottom;
    };
    const setActive = (item) => {
      if (active) active.classList.remove('is-active');
      active = item;
      if (item) {
        item.classList.add('is-active');
        keepInView(item);
      }
    };
    const visibleItems = () => matches || [...nodes().recent, ...nodes().full];

    return {
      visibleItems,
      focus() {
        nodes().filter.focus({ preventScroll: true });
      },
      filter(rawQuery) {
        const query = String(rawQuery || '').trim().toLocaleLowerCase();
        const { full, recent, recentGroup, allGroup, empty } = nodes();
        const ranked = full.map((el, order) => ({ el, order, rank: query ? matchRank(names[order], query) : 0 }));
        matches = query
          ? ranked.filter((entry) => entry.rank >= 0)
            .sort((a, b) => a.rank - b.rank || a.order - b.order)
            .map((entry) => entry.el)
          : null;
        for (const { el, rank } of ranked) el.hidden = rank < 0;
        if (matches) matches.forEach((el, at) => { el.style.order = String(at + 1); });
        else for (const el of full) el.style.removeProperty('order');
        for (const el of recent) el.hidden = !!query;
        recentGroup.hidden = !!query;
        allGroup.hidden = !!matches && !matches.length;
        empty.hidden = !matches || matches.length > 0;
        menu.scrollTop = 0;
        setActive(matches ? matches[0] || null : null);
      },
      // 方向键，和筛选框里（`target` 是按键落在的节点）的回车；别的键不归它，返回 false。
      handleKey(key, target) {
        const shown = visibleItems();
        if (key === 'ArrowDown' || key === 'ArrowUp') {
          const at = shown.indexOf(active);
          const step = key === 'ArrowDown' ? 1 : -1;
          const next = at < 0 ? (step > 0 ? 0 : shown.length - 1) : Math.min(Math.max(at + step, 0), shown.length - 1);
          setActive(shown[next] || null);
          return true;
        }
        if (key === 'Enter' && target === nodes().filter) {
          const pick = shown.includes(active) ? active : shown[0];
          if (pick) pick.click();
          return true;
        }
        return false;
      },
    };
  }

  /**
   * 把 `root`（.ai-translator-lang-dropdown：里面一个 .ai-translator-lang-trigger、
   * 一个 .ai-translator-lang-label、一个 .ai-translator-lang-menu）接成下拉。
   *
   * 返回 { value, isOpen, open, close, dismiss, relabel }：
   *   value     当前那一门（规范码）；赋值只改显示，不触发 onChange；
   *   relabel() 界面语言换了，按 labelOf 重写触发按钮上的名字；
   *   close()   调用处收起宿主（卡片、对话框）之前先调，菜单开着时挂在 document 上的
   *             两个监听就跟着摘掉。
   *
   * @param {Element} root
   * @param {{
   *   value: string,                                  初始值，规范码
   *   labelOf: (code) => string,                      触发按钮上写的名字
   *   buildMenu: (menu, value) => controller,         打开时画菜单（通常调 renderMenu）
   *   onChange: (code) => void                        用户选了一门
   * }} opts
   */
  function attachDropdown(root, { value, labelOf, buildMenu, onChange }) {
    const trigger = root.querySelector('.ai-translator-lang-trigger');
    const menu = root.querySelector('.ai-translator-lang-menu');
    const label = root.querySelector('.ai-translator-lang-label');
    if (!trigger || !menu || !label) throw new Error('LangPicker.attachDropdown: the root has no language dropdown');
    const doc = root.ownerDocument;

    // 当前值同时写在根节点的 data-value 上：宿主的样式、测试和读 DOM 的人都从那里看，
    // 不必拿触发按钮上随界面语言变的名字去猜。
    let current;
    const show = (code) => {
      current = code;
      label.textContent = labelOf(code);
      root.dataset.value = code;
    };
    show(value);

    // 这一次打开画出来的菜单的控制器：筛选、看得见的选项、当前项和方向键都归它；
    // 这里只管开、关和焦点。
    let controller = null;

    // 点在下拉外面就关菜单。
    const onOutsideMousedown = (event) => {
      if (!root.contains(event.target)) close();
    };
    // 菜单开着时 Escape 只关菜单，焦点在哪都一样。它挂在 document 的捕获阶段，用
    // stopImmediatePropagation 截住，宿主自己的 Escape（划词卡在冒泡阶段关卡片；输入框
    // 对话框也在捕获阶段，菜单开着时让路）就收不到。输入法组字时的 Escape 是输入法的，
    // 不碰。
    const onEscape = (event) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      dismiss();
    };

    const isOpen = () => !menu.hidden;
    const close = () => {
      if (menu.hidden) return;
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      doc.removeEventListener('mousedown', onOutsideMousedown);
      doc.removeEventListener('keydown', onEscape, true);
    };
    // 用键盘关掉菜单：焦点回到触发按钮，不落到 body 上。
    const dismiss = () => {
      close();
      trigger.focus({ preventScroll: true });
    };
    // 画完停在顶部，让「最近使用」一组露出来。当前语言已经写在触发按钮上，不为了把全表
    // 里的选中项滚到中部而把这组推出视口。菜单节点跨次打开复用，不赌重画后滚动位置自己
    // 归零，明确写 0。打开就把焦点放进筛选框，直接打字就是在找语言；preventScroll 不让
    // 聚焦去滚宿主页面。
    const open = () => {
      if (!menu.hidden) return;
      controller = buildMenu(menu, current);
      menu.hidden = false;
      menu.scrollTop = 0;
      trigger.setAttribute('aria-expanded', 'true');
      doc.addEventListener('mousedown', onOutsideMousedown);
      doc.addEventListener('keydown', onEscape, true);
      controller.focus();
    };

    trigger.addEventListener('click', (event) => {
      event.stopPropagation();
      if (menu.hidden) open();
      else close();
    });

    // 每输一个字重筛一次，有查询时当前项落在最贴的那一项上。
    menu.addEventListener('input', (event) => {
      if (!event.target.matches(FILTER)) return;
      controller.filter(event.target.value);
    });

    // 方向键与筛选框里的回车归控制器，处理完就不再往外传。输入法组字时的回车和方向键是
    // 输入法的，不归菜单。
    menu.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (!controller.handleKey(event.key, event.target)) return;
      event.preventDefault();
      event.stopPropagation();
    });

    menu.addEventListener('click', (event) => {
      const item = event.target.closest(ITEM);
      if (!item) return;
      const lang = item.dataset.lang;
      if (!lang) return;
      show(lang);
      close();
      onChange(lang);
    });

    return {
      get value() { return current; },
      set value(code) {
        show(code);
      },
      relabel() {
        label.textContent = labelOf(current);
      },
      isOpen,
      open,
      close,
      dismiss,
    };
  }

  const RECENT_KEY = 'recentTargetLangs';

  /** 存储里的「最近使用」→ 码的数组；不是数组、或混进了非字符串，都只留能用的。 */
  function parseRecent(value) {
    return Array.isArray(value) ? value.filter((code) => typeof code === 'string' && code) : [];
  }

  /**
   * 只读地跟着「最近使用」：先读一次，之后跟 onChanged。返回的 get() 给 renderMenu 的
   * recent——菜单每次打开重画，读到的就是那一刻的。
   * @param {typeof chrome.storage} storage
   */
  function watchRecent(storage) {
    let recent = [];
    storage.local.get(RECENT_KEY).then((stored) => { recent = parseRecent(stored[RECENT_KEY]); });
    storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[RECENT_KEY]) recent = parseRecent(changes[RECENT_KEY].newValue);
    });
    return { get: () => recent };
  }

  root.LangPicker = Object.freeze({
    SELECTORS: Object.freeze({ ITEM, FILTER }),
    RECENT_KEY,
    parseRecent,
    watchRecent,
    renderMenu,
    attachDropdown,
  });
})(globalThis);
