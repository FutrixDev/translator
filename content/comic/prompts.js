// Blab Translation 漫画翻译 —— 说给人听的话
//
// 未登录、要扣费、出错了——这三件事都发生在进度标下的卡片里，都需要用户点一下才继续。文案和
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

  /**
   * The two questions a job can stop on. Each settles `false` the moment its
   * card is destroyed, by whatever means — its own Cancel is just one of them,
   * so the chapter's Cancel all can never leave a run waiting on a card that
   * is no longer there.
   */
  function promptSignIn(overlay) {
    return new Promise((resolve) => {
      overlay.onDestroy(() => resolve(false));
      overlay.ask(t('comicSignInRequired'), { label: t('comicPillSignIn') });
      overlay.setActions([
        {
          label: t('comicSignIn'),
          variant: 'primary',
          onClick: async () => {
            overlay.setStatus(t('comicSigningIn'), { busy: true });
            const result = await comic.sendMessage({ type: 'COMIC_SIGN_IN' });
            if (result.ok) {
              overlay.setMessage('');
              overlay.setActions([]);
              resolve(true);
              return;
            }
            if (result.error.code === 'sign_in_cancelled') {
              overlay.destroy();
              return;
            }
            showFailure(overlay, result.error.message || t('comicSignInFailed'));
            resolve(false);
          }
        },
        { label: t('comicCancel'), onClick: () => overlay.destroy() }
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
      overlay.onDestroy(() => resolve(false));
      overlay.ask(chargeText(quote), { label: t('comicPillConfirm') });
      overlay.setActions([
        {
          label: t('comicChargeApprove'),
          variant: 'primary',
          onClick: () => {
            overlay.setMessage('');
            overlay.setActions([]);
            resolve(true);
          }
        },
        { label: t('comicCancel'), onClick: () => overlay.destroy() }
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

  /**
   * A refusal the account fixes carries its entry (`error.action`,
   * background/account-actions.js). Spent free pages get View plans, which
   * opens the pricing page tagged `comic_quota`, beside a dismiss button that
   * names the date the pages come back; the message adds that date and what a
   * plan holds (shared/quota-copy.js). Everything else is dismiss only.
   */
  function showJobError(overlay, error) {
    if (!error || error.action !== 'subscribe') {
      showFailure(overlay, errorText(error));
      return;
    }
    const offer = QuotaCopy.offerParts(error, t, ctx.uiLanguage());
    showFailure(overlay, [errorText(error), offer.reset, offer.plan].filter(Boolean).join(' '), [
      {
        label: t('quotaViewPlans'),
        variant: 'primary',
        onClick: async () => {
          const result = await comic.sendMessage({ type: 'BLAB_ACCOUNT_ACTION', action: 'subscribe', via: 'comic_quota' });
          if (result.ok) {
            overlay.destroy();
            return;
          }
          console.error('Blab Translation: the comic View plans entry failed', result.error);
          showFailure(overlay, t('blabActionFailed'));
        }
      },
      { label: offer.later, onClick: () => overlay.destroy() }
    ]);
  }

  /**
   * The job is over and did not succeed: the pill says so, the card says why,
   * with `actions` under it (Dismiss when none are given). A failed page in a
   * chapter is listed on the chapter pill, which is where the reader looks for
   * it, so its own card waits for a click on its pill rather than opening over
   * the page; alone on the page, it opens.
   */
  function showFailure(overlay, text, actions) {
    const open = !comic.summaryShown();
    overlay.setError(text, { open });
    overlay.setActions(actions || [{ label: t('comicDismiss'), onClick: () => overlay.destroy() }], { open });
  }

  /**
   * Server error codes → something a reader can act on.
   *
   * Codes, never message text: the server's messages are English and written
   * for a developer reading a log.
   */
  function errorText(error) {
    const code = error && error.code;
    if (QuotaCopy.isRefusal(code)) return t('comicInsufficientPoints');
    switch (code) {
      case 'image_too_large':
        return error.reason === 'webtoon_strip' ? t('comicWebtoonUnsupported') : t('comicImageTooLarge');
      case 'image_too_small': return t('comicImageTooSmall');
      case 'unsupported_aspect_ratio': return t('comicAspectUnsupported');
      case 'unsupported_format':
      case 'unreadable_image':
      case 'invalid_image_data':
      case 'invalid_image_url': return t('comicUnsupportedFormat');
      case 'gateway_unavailable': return t('comicServiceUnavailable');
      case 'image_unreadable': return t('comicImageUnavailable');
      // Three causes, three sentences: a stalled PUT, a PUT the storage
      // refused, and a request that never got an answer at all.
      case 'upload_timeout': return t('comicUploadTimeout');
      case 'upload_failed': return t('comicUploadFailed');
      case 'network_error':
      case 'no_response': return t('comicNetworkError');
      case 'extension_context': return t('extensionContextInvalidated');
      // An overlay that was already open when the switch went off; the worker
      // is the one that decides, so this is how that decision reads.
      case 'feature_disabled': return t('featureDisabled');
      // Why the redraw itself failed, as the job's poll names it.
      case 'comic_unsupported_script': return t('comicUnsupportedScript');
      case 'comic_no_text': return t('comicNoText');
      case 'comic_source_unreadable': return t('comicImageUnavailable');
      // Ours, not the page's: nothing the reader could change would help.
      case 'comic_translate_unparsable':
      case 'comic_internal':
      case 'failed': return t('comicFailed');
      default:
        // A code this build does not know yet (the service names failures the
        // extension learns later). Still a failure the reader is told about,
        // in general words; the code goes to the console once so it can be
        // given words of its own.
        console.warn('[comic] no wording for failure code', code);
        return t('comicFailed');
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
    promptCharge, promptSignIn, showDetachedError, showFailure, showJobError,
  });
})();
