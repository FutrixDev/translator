// Blab Translation 设置页 —— 发送反馈
//
// options.html 按顺序加载的普通脚本，和 options.js 共用同一个全局词法作用域。
//
// Feedback is filed on the account site (text and a few screenshots), which
// requires an account. A signed-out click runs the page's one sign-in flow
// first; then the worker opens the form, signing the site in as this account
// so the reader does not meet a second sign-in there.

async function openFeedback() {
  if (!(await ensureSignedIn())) {
    showStatus(t('feedbackSignInRequired'), 'error');
    return;
  }
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: 'SITE_OPEN_FEEDBACK', via: 'options' });
  } catch (error) {
    response = { ok: false, error };
  }
  if (!response || !response.ok) {
    console.error('Blab Translation: opening the feedback form failed', response && response.error);
    showStatus(t('feedbackOpenFailed'), 'error');
  }
}
