// Blab Translation background — AI 配置档：service worker 这一半（设计 §2.5、§2.6、§3.6）。
//
// 写入（AI_PROFILES_WRITE）和别的集合一样走 background.js 的 STORAGE_WRITERS 转接
// 到 AIProfiles.applyWrite 的单写队列；这里管剩下的四件事：
//   - ensureMigrated()：旧四键 → aiProfile:legacy。记住结果，失败就忘掉、下次再试；
//     每个读配置档的入口先 await 它。
//   - profileById(id) / profileFor(feature)：翻译消息按 profileId 取整档（含 Key），
//     图片识别在这里按 'ocr' 选档（站点规则不管 OCR）。
//   - AI_PROFILES_PUBLIC：内容脚本镜像要的公开形状（不含 Key）；AI_PROFILES_READY
//     {feature}：没有内容脚本的页面上，弹出窗口问「AI 配好没有」。
//   - AI_PROFILE_TEST {profile}：设置页的测试连接，用表单里还没保存的档发一个最小
//     请求；不入缓存、不计额度、不过限速。
//
// 消息监听只认这三条：别的消息既不回话也不 return true。

import '../shared/api-compat.js';
import '../shared/engines.js';
import { callModel } from './model-client.js';
import { profileError, replyError } from './api-errors.js';
import { defaultSettings } from './settings.js';

let migrated = null;

/** 旧四键存过任何一个就迁一次；同一个 SW 生命周期里只迁一次，失败下次再试。 */
function ensureMigrated() {
  if (!migrated) {
    migrated = (async () => {
      const AIProfiles = globalThis.AIProfiles;
      const stored = await chrome.storage.sync.get(Array.from(AIProfiles.LEGACY_KEYS));
      if (Object.keys(stored).length === 0) return;
      await AIProfiles.applyWrite({ type: 'AI_PROFILES_WRITE', kind: 'migrateLegacy' });
    })();
    migrated.catch(() => { migrated = null; });
  }
  return migrated;
}

async function profiles() {
  await ensureMigrated();
  return globalThis.AIProfiles.collection.cached();
}

/**
 * 消息里带来的那一档（含 Key）。没带 id 是调用方的错；带了却不在是用户能看到的错。
 * 'blab' 引擎的请求带的是 Engines.BLAB_PROFILE 的 id：那一档不存储，原样回它。
 */
async function profileById(id) {
  if (!id) throw new TypeError('profileById: the request carries no profileId');
  if (id === globalThis.Engines.BLAB_PROFILE.id) return globalThis.Engines.BLAB_PROFILE;
  const profile = (await profiles()).find((entry) => entry.id === id);
  if (!profile) throw profileError('aiProfileMissing', id);
  return profile;
}

/** SW 自己选档（没有站点规则）：图片识别按 'ocr'。 */
async function profileFor(feature) {
  const resolved = globalThis.AIProfiles.resolve(await profiles(), { feature });
  if (resolved.error) throw profileError(resolved.error, resolved.id);
  return resolved.profile;
}

async function publicProfiles() {
  return (await profiles()).map(globalThis.AIProfiles.publicView);
}

async function ready(feature) {
  const resolved = globalThis.AIProfiles.resolve(await profiles(), { feature });
  return Boolean(resolved.profile) && !globalThis.APICompat.isApiKeyMissing(resolved.profile);
}

// 20 个 token 够回一句 "Hi"；推理模型的隐藏 token 下限由 api-compat 的构造器抬。
const PROBE_TOKENS = 20;

async function testProfile(draft) {
  const settings = await chrome.storage.sync.get(defaultSettings);
  let profile;
  try {
    profile = globalThis.AIProfiles.normalize(draft);
    // 测试连接要的是立刻知道这一档通不通：不重试，也不进限速器（设计 §3.9）。
    await callModel(profile, {
      system: '',
      user: 'Hi',
      maxTokens: PROBE_TOKENS,
      temperature: globalThis.APICompat.DEFAULT_TEMPERATURE,
    }, { retry: false, limit: false });
    return { ok: true };
  } catch (error) {
    return replyError('AI_PROFILE_TEST', error, { settings, profile, feature: '(test)' });
  }
}

function reply(promise, sendResponse, operation) {
  promise.then(sendResponse, (error) => {
    console.error(`${operation} failed:`, error);
    sendResponse({ error: error.message });
  });
  return true;
}

export function handleMessage(message, sender, sendResponse) {
  switch (message && message.type) {
    case 'AI_PROFILES_PUBLIC':
      return reply(publicProfiles().then((list) => ({ profiles: list })), sendResponse, 'AI_PROFILES_PUBLIC');
    case 'AI_PROFILES_READY':
      return reply(ready(message.feature).then((value) => ({ ready: value })), sendResponse, 'AI_PROFILES_READY');
    case 'AI_PROFILE_TEST':
      return reply(testProfile(message.profile), sendResponse, 'AI_PROFILE_TEST');
    default:
      return undefined;
  }
}

chrome.runtime.onMessage.addListener(handleMessage);

export { ensureMigrated, profileById, profileFor };
