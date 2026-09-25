// 设置页上所有语言名的唯一画法。名字由 TargetLang（Intl.DisplayNames）按界面语言
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
  fillLanguageSelect(document.getElementById('targetLang'), TargetLang.options(uiLang));

  const cloud = TargetLang.options(uiLang, TargetLang.CLOUD_TARGETS);
  fillLanguageSelect(document.getElementById('comicTargetLang'), cloud);
  fillLanguageSelect(document.getElementById('pdfTargetLang'), cloud);

  // 界面语言选择器用本名、按 UI_LANGUAGES 的顺序：误切成看不懂的语言时，
  // 还能认出自己那门。
  fillLanguageSelect(document.getElementById('uiLanguage'),
    UI_LANGUAGES.map((code) => ({ value: code, label: TargetLang.autonym(code) })));

  for (const input of document.querySelectorAll('#autoTranslateLangs input[data-lang]')) {
    input.nextElementSibling.textContent = TargetLang.nameOf(input.dataset.lang, uiLang);
  }
}
