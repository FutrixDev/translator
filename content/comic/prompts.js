// Blab Translation 漫画翻译 —— 说给人听的话
//
// 未登录、要扣费、出错了——这三件事都发生在覆盖层上，都需要用户点一下才继续。文案和
// 按钮排布收在这里，任务流只管在该问的时候问。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;
  // 这一族共用的架子，说明见 content/content-comic-translation.js 顶上。
  const comic = (ctx.comic = ctx.comic || {});

  const t = ctx.t;
  const escapeHtml = ctx.escapeHtml;

  // -------------------------------------------------------------------------
  // Error and account surfaces
  // -------------------------------------------------------------------------

  function promptSignIn(overlay) {
    return new Promise((resolve) => {
      overlay.setStatus(t('comicSignInRequired'), { busy: false });
      overlay.setActions([
        {
          label: t('comicSignIn'),
          variant: 'primary',
          onClick: async () => {
            overlay.setStatus(t('comicSigningIn'), { busy: true });
            const result = await comic.sendMessage({ type: 'COMIC_SIGN_IN' });
            if (result.ok) {
              resolve(true);
              return;
            }
            if (result.error.code === 'sign_in_cancelled') {
              overlay.destroy();
              resolve(false);
              return;
            }
            overlay.setError(result.error.message || t('comicSignInFailed'));
            offerDismiss(overlay);
            resolve(false);
          }
        },
        {
          label: t('comicCancel'),
          onClick: () => {
            overlay.destroy();
            resolve(false);
          }
        }
      ]);
    });
  }

  /**
   * Ask the reader to spend credits on this page.
   *
   * Only ever reached from a server 409: the monthly allowance covers a page
   * without any confirmation at all (B4 §「额度内零确认 / 需积分一次汇总确认」),
   * so this card appears exactly when real credits are about to be spent, and
   * never for free work.
   *
   * Approving clears the buttons before returning. The cancel button belongs to
   * the question, and the question is over — but the job is not yet created, so
   * a late click on a stale Cancel would tear down the overlay while a paid
   * create was still in flight, leaving a redraw nobody is watching.
   */
  function promptCharge(overlay, quote) {
    return new Promise((resolve) => {
      overlay.setStatus(chargeText(quote), { busy: false });
      overlay.setActions([
        {
          label: t('comicChargeApprove'),
          variant: 'primary',
          onClick: () => {
            overlay.setActions([]);
            resolve(true);
          }
        },
        {
          label: t('comicCancel'),
          onClick: () => {
            overlay.destroy();
            resolve(false);
          }
        }
      ]);
    });
  }

  /**
   * The price, in the reader's language — the shared sentence with this
   * feature's wording in it. The two-numbers-or-neither rule lives in
   * shared/comic-charge.js, where the PDF surfaces read it too.
   */
  function chargeText(quote) {
    return ComicCharge.chargeText(quote, t, {
      required: 'comicChargeRequired',
      fallback: 'comicChargeConfirm'
    });
  }

  function showJobError(overlay, error) {
    // Dismiss is the only action, including for a used-up monthly allowance:
    // there is nothing to buy, so an "act now" button would lead nowhere. The
    // message names the reset date instead.
    overlay.setError(errorText(error));
    offerDismiss(overlay);
  }

  function offerDismiss(overlay) {
    overlay.setActions([{ label: t('comicDismiss'), onClick: () => overlay.destroy() }]);
  }

  /**
   * Server error codes → something a reader can act on.
   *
   * Codes, never message text: the server's messages are English and written
   * for a developer reading a log.
   */
  function errorText(error) {
    const code = error && error.code;
    switch (code) {
      case 'insufficient_points': return t('comicInsufficientPoints');
      case 'image_too_large':
        return error.reason === 'webtoon_strip' ? t('comicWebtoonUnsupported') : t('comicImageTooLarge');
      case 'image_too_small': return t('comicImageTooSmall');
      case 'unsupported_aspect_ratio': return t('comicAspectUnsupported');
      case 'unsupported_format':
      case 'unreadable_image':
      case 'invalid_image_data':
      case 'invalid_image_url': return t('comicUnsupportedFormat');
      case 'gateway_unavailable': return t('comicServiceUnavailable');
      case 'network_error':
      case 'no_response': return t('comicNetworkError');
      case 'extension_context': return t('extensionContextInvalidated');
      // An overlay that was already open when the switch went off; the worker
      // is the one that decides, so this is how that decision reads.
      case 'feature_disabled': return t('featureDisabled');
      default: return t('comicFailed');
    }
  }

  /** Last resort when there is no image to anchor to. */
  function showDetachedError(message) {
    const toast = document.createElement('div');
    toast.className = 'ai-translator-comic-toast';
    toast.innerHTML = `<span>${escapeHtml(message)}</span>`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  // 别的文件要用的，都从这张架子上取。
  Object.assign(comic, {
    offerDismiss, promptCharge, promptSignIn, showDetachedError, showJobError,
  });
})();
