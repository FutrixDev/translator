// Blab Translation background — 功能开关的判定。
//
// 两个服务端功能（漫画、PDF）由「设置里的开关」和「这台设备登没登录」共同决定，
// 菜单要不要画读的是合成之后那一份，真要动手花钱之前读的是开关那一半（登录那一
// 半在 apiFetch 里答 unauthorized，每个界面都会把它变成一次登录邀请）。
//
// 单独成一个模块，是为了让菜单和 PDF 两边都能用它而不互相 import —— 它本来也不
// 是菜单的代码。

import '../shared/account-gate.js';
import * as comicClient from './comic-client.js';
import { defaultSettings } from './settings.js';

/**
 * Settings with the account gate applied — the only shape the rest of this
 * worker should judge the two server-backed features from. See
 * shared/account-gate.js.
 */
async function getGatedSettings() {
  return AccountGate.applyAccountGate(await chrome.storage.sync.get(defaultSettings));
}

/**
 * Refuse a job for a feature whose switch is off.
 *
 * Hiding entry points only governs what gets rendered next. A surface that was
 * already open when the switch went off keeps its buttons — an upload page, the
 * popup, a comic overlay sitting on a page — and can still send a create. This
 * is the one point both features funnel through, so it is the only place the
 * answer can be relied on; without it a switched-off feature can still upload a
 * document and spend the month's allowance.
 *
 * Reads the raw switch, NOT getGatedSettings(): the account half of the gate is
 * already enforced one layer down, where apiFetch answers a create with no
 * token as `unauthorized` — and every surface turns that into a sign-in offer.
 * Answering `feature_disabled` instead would name the wrong problem and leave
 * the user nothing to do about it.
 */
async function assertFeatureEnabled(key) {
  const settings = await chrome.storage.sync.get(defaultSettings);
  if (!settings[key]) {
    throw new comicClient.ComicApiError('feature_disabled', `${key} is turned off`);
  }
}

export { getGatedSettings, assertFeatureEnabled };
