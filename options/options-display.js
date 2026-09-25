// Blab Translation 设置页 —— 译文样式
//
// options.html 按顺序加载的普通脚本，和 options.js 共用同一个全局词法作用域：
// 这里声明的函数在 options.js 里直接叫名字就能用，反过来也一样（调用发生在
// DOMContentLoaded 之后，声明早就求值完了）。
//
// 这张卡片上的预览不是仿制品：options.html 直接链了 content/css/translation.css，
// 预览里那一行就是一个真的 .ai-translator-inline-block，本页 <html> 上挂着和网页
// 上同一个 data-ai-translator-style 属性。所以预览长什么样，网页上的译文就长什么
// 样，样式只写在一处。
//
// 值本身走 options.js 的通路：translationStyle 在 IMMEDIATE_SAVE_FIELDS 里，
// loadSettings / collectSettings 各一行。这里只管选项从哪来、预览怎么跟。

// 选项由 TranslationDisplay.STYLES 生成，不在 HTML 里手写：集合只有一份。
// 在脚本加载时就生成（此时 <select> 已经在文档里，脚本在 body 末尾），好让随后的
// applyI18n 像翻其它选项一样按 data-i18n 翻它们，loadSettings 也能直接设 value。
(function populateTranslationStyleSelect() {
  const select = document.getElementById('translationStyle');
  TranslationDisplay.STYLES.forEach((style) => {
    const option = document.createElement('option');
    option.value = style;
    option.setAttribute('data-i18n', TranslationDisplay.styleLabelKey(style));
    select.appendChild(option);
  });
})();

// 本页 <html> 上的样式属性跟着下拉框走，和网页上同一个函数写。
function syncTranslationStylePreview() {
  TranslationDisplay.applyStyleAttribute(document, document.getElementById('translationStyle').value);
}

document.getElementById('translationStyle').addEventListener('change', syncTranslationStylePreview);
