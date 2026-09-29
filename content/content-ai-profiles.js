// Blab Translation — 本页的 AI 配置档镜像（ctx.aiProfiles，P1-D 设计 §3.3）
//
// 配置档存在 sync 里，一档一个 `aiProfile:<id>` 键（shared/ai-profiles.js）。这个
// 文件只建本 frame 的镜像：向 SW 要一次公开形状（AI_PROFILES_PUBLIC，不含 Key，
// 只说 keyMissing），此后跟着 bootstrap 转来的增量走（ctx.syncMirrors 登记表）。
//
// **每个 frame 都建。** 子 frame 的翻译请求经信封交给顶层执行、由顶层选档，但子
// frame 自己也要答「AI 这一路能不能用」（回落谓词、换引擎按钮），那一问读本 frame
// 的镜像；站点规则指定的档由顶层指令带下来（ctx.customRules.profileOverride）。
//
// 三个状态：'pending'（还没回话）、'ready'（回话到了）、'failed'（请求失败，或
// 1500 ms 上限先到）。晚到的回话照样把状态翻成 'ready' 并通知订阅者。
//   - resolve(feature) 在非 'ready' 时抛：发请求的路径等过 whenReady() 仍不是
//     'ready'，就是镜像坏了，不拿空表假装「未配置」；
//   - ready(feature) 是谓词：非 'ready' 答 false（回落与换引擎只是不提供 AI）。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const AIProfiles = globalThis.AIProfiles;

  let mirror = null;
  let state = 'pending';
  let ready = null;
  // 订阅者单独记：缓存层与调度器可能在 init() 之前订阅。
  const subscribers = new Set();

  function notify() {
    for (const fn of Array.from(subscribers)) {
      try {
        fn();
      } catch (error) {
        console.error('Blab Translation: AI profiles subscriber failed', error);
      }
    }
  }

  function request() {
    return chrome.runtime.sendMessage({ type: 'AI_PROFILES_PUBLIC' }).then((reply) => {
      if (!reply) throw new Error('AI_PROFILES_PUBLIC got no reply');
      if (reply.error) throw new Error(reply.error);
      if (!Array.isArray(reply.profiles)) throw new Error('AI_PROFILES_PUBLIC reply has no profiles list');
      return reply.profiles;
    }).then(
      (list) => {
        state = 'ready';
        return list;
      },
      (error) => {
        state = 'failed';
        throw error;
      },
    );
  }

  function init() {
    if (mirror) return;
    mirror = AIProfiles.publicCollection.mirror({ request, host: location.hostname });
    mirror.subscribe(notify);
    ready = mirror.whenReady().then(() => {
      if (state === 'pending') state = 'failed';
    });
    ctx.syncMirrors.push({
      prefix: AIProfiles.KEY_PREFIX,
      onStorageChange: ctx.aiProfiles.onStorageChange,
    });
  }

  /** 本页这个功能选中的档：{profile} 或 {error, id?}（AIProfiles.resolve 的形状）。 */
  function resolve(feature) {
    if (state !== 'ready') throw new Error(`ctx.aiProfiles: profiles are ${state}`);
    return AIProfiles.resolve(mirror.entries(), {
      feature,
      ruleProfileId: ctx.customRules.profileOverride(),
    });
  }

  ctx.aiProfiles = {
    init,
    whenReady: () => {
      if (!ready) throw new Error('ctx.aiProfiles.whenReady() before init()');
      return ready;
    },
    status: () => state,
    resolve,
    ready(feature) {
      if (state !== 'ready') return false;
      const resolved = resolve(feature);
      return Boolean(resolved.profile) && !resolved.profile.keyMissing;
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    onStorageChange: (changes) => {
      if (mirror) mirror.onStorageChange(changes);
    },
  };
})();
