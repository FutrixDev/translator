// Blab Translation background — 功能开关的判定。
//
// 两个服务端功能（漫画、PDF）由「设置里的开关」和「这台设备登没登录」共同决定，
// 答案是 AccountGate.featureState() 的三态之一：off（用户亲手关了）、signed_out
// （开着但没登录——该邀请登录，而不是装作没有这个功能）、ready。
//
// 单独成一个模块，是为了让菜单和 PDF 两边都能用它而不互相 import —— 它本来也不
// 是菜单的代码。

import '../shared/account-gate.js';
import * as comicClient from './comic-client.js';

/** The state of one account-backed feature on this device, right now. */
function featureState(key) {
  return AccountGate.readFeatureState(key);
}

/**
 * Refuse a job for a feature the user turned off.
 *
 * Hiding entry points only governs what gets rendered next. A surface that was
 * already open when the switch went off keeps its buttons — an upload page, the
 * popup, a comic overlay sitting on a page — and can still send a create. This
 * is the one point both features funnel through, so it is the only place the
 * answer can be relied on; without it a switched-off feature can still upload a
 * document and spend the month's allowance.
 *
 * `consent` is the one way past it: the user pressed the media shortcut or the
 * page hint's button on this page, which is an explicit request for this page
 * alone (D-353) — the switch itself is left as it is. Callers set it from what
 * the user did, never from a field a page could put in a message.
 *
 * Only `off` refuses. `signed_out` is enforced one layer down, where apiFetch
 * answers a create with no token as `unauthorized` — and every surface turns
 * that into a sign-in offer. Answering `feature_disabled` instead would name the
 * wrong problem and leave the user nothing to do about it.
 */
async function assertFeatureEnabled(key, { consent = false } = {}) {
  if (consent) return;
  if (await featureState(key) === AccountGate.FEATURE_STATES.OFF) {
    throw new comicClient.ComicApiError('feature_disabled', `${key} is turned off`);
  }
}

export { featureState, assertFeatureEnabled };
