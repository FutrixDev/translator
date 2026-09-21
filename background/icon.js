// Blab Translation background — 工具栏图标跟着主题走。

// Update extension icon based on theme
async function updateIcon(theme) {
  const suffix = theme === 'light' ? '-light' : '';
  const iconPaths = {
    "16": `icons/icon16${suffix}.png`,
    "32": `icons/icon32${suffix}.png`,
    "48": `icons/icon48${suffix}.png`,
    "128": `icons/icon128${suffix}.png`
  };
  
  try {
    await chrome.action.setIcon({ path: iconPaths });
  } catch (error) {
    // If light icons don't exist, fall back to default icons
    if (suffix === '-light') {
      console.log('Light icons not found, using default icons');
      await chrome.action.setIcon({
        path: {
          "16": "icons/icon16.png",
          "32": "icons/icon32.png",
          "48": "icons/icon48.png",
          "128": "icons/icon128.png"
        }
      }).catch(() => {});
    }
  }
}

// 只听主题这一个键。菜单那几个键在 context-menus.js 自己听自己的 —— MV3 允许注册
// 多个 onChanged 监听器，两个部件各管各的比一个大分支好拆。
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'sync' && changes.theme) {
    updateIcon(changes.theme.newValue);
  }
});

// Initialize icon on startup
chrome.storage.sync.get({ theme: 'light' }, (result) => {
  updateIcon(result.theme);
});

export { updateIcon };
