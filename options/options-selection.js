// Blab Translation 设置页 —— 划词翻译的几颗控件谁管谁
//
// options.html 按顺序加载的普通脚本，和 options.js 共用同一个全局词法作用域
// （做法同 options-display.js）。值的通路仍在 options.js：selectionTrigger 在
// IMMEDIATE_SAVE_FIELDS、CONFLICT_FIELDS 里，loadSettings / collectSettings 各一行。
//
// 四个设置的分工：
//   - enableSelection            总开关，关了底下三颗全部灰掉；
//   - selectionTrigger           选中之后怎么触发：图标 / 修饰键 / 两者都要；
//   - selectionTranslationMode   修饰键、悬浮球、右键菜单的译文画在哪。图标不看
//                                它（总是开卡片），但悬浮球和右键菜单还在用，所以
//                                触发方式是「图标」时它**不**灰；
//   - selectionTranslationHotkey 哪个修饰键。触发方式是「图标」时它不起作用，灰掉。
function syncSelectionControls() {
  const enabled = document.getElementById('enableSelection').checked;
  const iconOnly = document.getElementById('selectionTrigger').value === 'icon';
  document.getElementById('selectionTrigger').disabled = !enabled;
  document.getElementById('selectionTranslationMode').disabled = !enabled;
  document.getElementById('selectionTranslationHotkey').disabled = !enabled || iconOnly;
}

document.getElementById('selectionTrigger').addEventListener('change', syncSelectionControls);
