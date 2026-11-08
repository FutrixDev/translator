// 设置页上所有语言名的唯一画法。目标语言是划词卡、工具栏弹窗共用的那个下拉
// （shared/lang-picker.js），由这里的 setupTargetLangPicker 接上；其余几个仍是 select。名字由 TargetLang（Intl.DisplayNames）按界面语言
// 现算，html 里不再写死任何一门语言的 <option>。
//
// 调两次：
//   1. loadSettings 在给任何 select 赋值之前 —— select 里没有那个 option 时，
//      `select.value = 'fa'` 会静默落空，停在空值上；
//   2. applyI18n 末尾 —— 切界面语言时名字跟着重画。
//
// 只换 option，不换 select 元素本身：options-account.js 按账号禁用漫画、PDF 两个
// 选择器，换掉元素就把这个状态冲掉了。重画前记下当前值，画完写回。

/** 把 select 里空值之外的 option 换成 `items`，保住当前值和空值那一项。 */
function fillLanguageSelect(select, items) {
  const value = select.value;
  for (const option of [...select.options]) {
    if (option.value !== '') option.remove();
  }
  for (const { value: code, label } of items) {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = label;
    select.appendChild(option);
  }
  select.value = value;
}

function renderLanguageOptions(uiLang) {
  // 目标语言不是 select，是划词卡那个下拉：名字在触发按钮上，菜单打开时现画。
  targetLangPicker?.relabel();

  const cloud = TargetLang.options(uiLang, TargetLang.CLOUD_TARGETS);
  fillLanguageSelect(document.getElementById('comicTargetLang'), cloud);
  fillLanguageSelect(document.getElementById('pdfTargetLang'), cloud);

  // 界面语言选择器用本名、按 UI_LANGUAGES 的顺序：误切成看不懂的语言时，
  // 还能认出自己那门。
  fillLanguageSelect(document.getElementById('uiLanguage'),
    UI_LANGUAGES.map((code) => ({ value: code, label: TargetLang.autonym(code) })));
}

// ---------------------------------------------------------------------------
// 目标语言下拉
//
// 和划词卡、输入框对话框是同一个下拉：同一份菜单、同一个筛选、同一组「最近使用」
// （chrome.storage.local 的 recentTargetLangs，翻译派发时由内容脚本记下，这一页只读）。
// 「仅 AI」标记问的是这一页正选着的手动引擎：内置时，端上译不了的语言带上它，和
// 语言包那一行、引擎抛 UNSUPPORTED_PAIR 用同一个谓词（supportsTarget）。
// ---------------------------------------------------------------------------

let targetLangPicker = null;

/** 接上下拉；`onChange(code)` 只在用户选了一门时调。 */
function setupTargetLangPicker(value, onChange) {
  const recent = LangPicker.watchRecent(chrome.storage);
  targetLangPicker = LangPicker.attachDropdown(document.getElementById('targetLang'), {
    value,
    labelOf: (code) => TargetLang.nameOf(code, currentUILang),
    buildMenu: (menu, selected) => {
      const engine = getBuiltinEngine();
      const builtin = elements.translationEngine.value === 'builtin' && engine;
      return LangPicker.renderMenu(menu, {
        selected,
        uiLang: currentUILang,
        recent: recent.get(),
        aiOnly: builtin ? (code) => !engine.supportsTarget(code) : null,
        t,
      });
    },
    onChange,
  });
}
