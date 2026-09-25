// Blab Translation 设置页 —— 别处改了设置，这一页跟上
//
// options.html 按顺序加载的普通脚本，和 options.js 共用同一个全局词法作用域：
// 这里声明的函数在 options.js 里直接叫名字就能用，反过来也一样（调用发生在
// DOMContentLoaded 之后，声明早就求值完了）。
//
// 这一页的写法是「整张表单一起存」（collectSettings → storage.sync.set）。设置
// 页开着的时候，别处 —— popup 的显示行、悬浮球、Alt+T、popup 的站点开关顺带打开
// 的 autoTranslate —— 改了一个键，这一页的控件还停在旧值上；用户随后在这里动任
// 何一颗别的开关，整张表单存回去，就把别处刚改的值悄悄盖掉了。
//
// 所以对 IMMEDIATE_SAVE_FIELDS 里的键，存储一变就把控件回填成新值：
//   - 只在控件值确实不同时回填，并且不派发 change —— 派发了就会再存一遍，两个
//     设置页之间来回弹。这一页自己写进去的值回弹到这里时，控件本来就是这个值，
//     什么也不做。
//   - lastGoodSettings 里的同名键一起更新：快捷键冲突回滚退回的就是它，留着旧值
//     等于回滚到别处已经改掉的状态。
//   - 重跑这个键在 change 监听里挂的派生界面函数（变灰、预览、状态），但不写存储。
// 去抖的文本字段（DEBOUNCED_SAVE_FIELDS）不镜像：用户正在打字，回弹会覆盖他。

// 键 → 该键 change 监听里的派生界面函数（见 options.js 的 setupEventListeners，
// 以及 options-display.js）。只列有派生函数的键；其余键回填控件就够了。
// 写成箭头函数，是因为这张表在调用时才解析名字 —— 有几个函数声明在 options.js 里，
// 本文件加载时它们还没求值。
const SYNC_MIRROR_DERIVED = {
  translationEngine: () => { refreshBuiltinStatus(); syncAutoEngineState(); },
  engineFallback: () => { refreshBuiltinStatus(); syncAutoEngineState(); },
  enableSelection: () => syncInlineSettingState(),
  selectionTrigger: () => syncSelectionControls(),
  enableHoverTranslation: () => syncInlineSettingState(),
  enableImageOcrTranslation: () => syncOcrSubState(),
  autoTranslate: () => { syncAutoSubState(); syncYoutubeSubState(); },
  captionDisplayMode: () => updateCaptionPreview(),
  captionTranslationPosition: () => updateCaptionPreview(),
  translationStyle: () => syncTranslationStylePreview()
};

// 一个键被删掉（newValue 为 undefined）就按默认值回填，和 loadSettings 读到缺省
// 值时一样。
function mirrorStoredValue(key, change) {
  const el = elements[key];
  const value = change.newValue === undefined ? defaultSettings[key] : change.newValue;
  if (el.type === 'checkbox') {
    if (el.checked === !!value) return false;
    el.checked = !!value;
  } else {
    if (el.value === String(value)) return false;
    // 存储里是这个下拉框没有的值（更新或更旧的版本写的）：设进去 value 会变成
    // 空串，下一次整表存回去就把空串写进存储。不回填，说出来。
    if (!Array.from(el.options).some((option) => option.value === String(value))) {
      console.warn(`[options] ${key}: stored value has no option here, not mirrored`);
      return false;
    }
    el.value = String(value);
  }
  if (lastGoodSettings) lastGoodSettings[key] = el.type === 'checkbox' ? el.checked : el.value;
  return true;
}

function setupSyncMirror() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    IMMEDIATE_SAVE_FIELDS.forEach((key) => {
      if (!(key in changes)) return;
      if (mirrorStoredValue(key, changes[key]) && SYNC_MIRROR_DERIVED[key]) {
        SYNC_MIRROR_DERIVED[key]();
      }
    });
  });
}
