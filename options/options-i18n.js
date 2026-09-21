// Blab Translation 设置页 —— 界面语言与平台文案
//
// options.html 按顺序加载的普通脚本，和 options.js 共用同一个全局词法作用域：
// 这里声明的函数在 options.js 里直接叫名字就能用，反过来也一样（调用发生在
// DOMContentLoaded 之后，声明早就求值完了）。
//
// currentUILang 是这一页「现在用哪种语言说话」的唯一答案，t() 和一切运行时画出
// 来的文案都读它。applyI18n 末尾要重画的那两块（站点审计表、本机统计）不带
// data-i18n，只能整块重画 —— 它们的渲染函数在 options-auto.js。

function getPlatformType() {
  const platform = ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '').toLowerCase();
  if (platform.includes('mac')) return 'mac';
  if (platform.includes('win')) return 'windows';
  if (platform.includes('linux')) return 'linux';
  return 'other';
}

// Current UI language
let currentUILang = 'en';

// i18n helper
function t(key) {
  return getMessage(key, currentUILang);
}

// Apply i18n to page
function applyI18n(lang) {
  currentUILang = getUILanguage(lang);
  
  // Update all elements with data-i18n attribute
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const text = t(key);
    if (text && text !== key) {
      el.textContent = text;
    }
  });
  
  // Update title attributes
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    const text = t(key);
    if (text && text !== key) {
      el.title = text;
    }
  });

  // Update alt attributes
  document.querySelectorAll('[data-i18n-alt]').forEach(el => {
    const key = el.getAttribute('data-i18n-alt');
    const text = t(key);
    if (text && text !== key) {
      el.setAttribute('alt', text);
    }
  });

  // Update hint text (allow inline markup)
  document.querySelectorAll('[data-i18n-hint]').forEach(el => {
    const key = el.getAttribute('data-i18n-hint');
    const text = t(key);
    if (text && text !== key) {
      el.innerHTML = text;
    }
  });

  // Update placeholders
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    const text = t(key);
    if (text && text !== key) {
      el.setAttribute('placeholder', text);
    }
  });
  
  // Update document title
  document.title = `${t('appName')} - ${t('settings')}`;

  // 站点审计表和本机统计是运行时画出来的（主机名、按 locale 格式化的数字、
  // 「总是翻译」这类行内文案），身上没有 data-i18n，上面那几轮选择器一个也扫
  // 不到。不在这里重画，换过界面语言的中文页面上就留着一排英文的按钮。
  renderSiteRules();
  renderAutoStats();

  // Show the real extension version from the manifest instead of a hard-coded
  // string, so the settings page never drifts from the released version.
  const versionEl = document.querySelector('[data-i18n="appNameVersion"]');
  if (versionEl) {
    try {
      const version = chrome.runtime.getManifest().version;
      versionEl.textContent = `${t('appName')} v${version}`;
    } catch (e) {
      // getManifest() may be unavailable in some contexts; keep the i18n fallback.
    }
  }
}

function applyPlatformHotkeyLabels() {
  const platformType = getPlatformType();
  if (platformType === 'other') return;

  const selects = [elements.selectionTranslationHotkey, elements.hoverTranslationHotkey].filter(Boolean);
  const labelMapByPlatform = {
    mac: {
      Shift: '⇧ Shift',
      Alt: '⌥ Option',
      Control: '⌃ Control',
      Meta: '⌘ Command',
    },
    windows: {
      Meta: '⊞ Win',
    },
    linux: {
      Meta: 'Super',
    },
  };

  const labelMap = labelMapByPlatform[platformType] || null;
  if (!labelMap) return;

  selects.forEach((select) => {
    Array.from(select.options).forEach((option) => {
      const mapped = labelMap[option.value];
      if (mapped) option.textContent = mapped;
    });
  });
}
