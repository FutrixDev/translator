// Blab Translation 引擎一族：一次请求若发给模型，发给哪一个模型引擎、用哪一档。
//
// 模型引擎有两个（shared/engines.js 的 MODEL_ENGINES）：
//
//   'ai'    用户自己的接口：这个功能解析出的 AI 配置档（AIProfiles.resolve 的形状，
//           {profile} | {error, id}），他的 Key，他的账单
//   'blab'  Blab Translation：固定的 Engines.BLAB_PROFILE，没有 Key、没有可改的字段，
//           SW 按它的 id 认出来、发到账户的 /api/blab/complete（D-477）
//
// 两个送出口（ctx.sendTranslation 与缓存层的 ctx.sendTranslationCached）都问
// forRequest，缓存键里的接口地址与模型和真正发出去的那一档出自同一个答案；Blab
// 那一档的 apiEndpoint / modelName 都是 'blab'，正是设计 §5.3 的两个键因子。
//
// 跨文件的名字写成 `eng.foo`、调用时才取（入口挂上 pinnedEngine / selectedEngine），
// 所以这一份排在入口之前或之后都行；装载清单与其余引擎文件一起排在入口之前。
(function() {
  'use strict';

  if (globalThis.FrameEligibility && !globalThis.FrameEligibility.shouldActivate()) return;
  const ctx = window.AI_TRANSLATOR_CONTENT || (window.AI_TRANSLATOR_CONTENT = {});
  const eng = (ctx.engine = ctx.engine || {});

  /**
   * `{ engine, resolved }`：这一次请求发给模型时的模型引擎（'ai' | 'blab'）和它的档。
   *
   * 引擎按指名 > 本站规则 > 设置（eng.selectedEngine，自动请求问自动那一张开关）。
   * 选了内置、内置顶不住而回落到模型的，是用户自己的 AI：engineFallback 的
   * 'allow-ai' 说的就是「本地不可用时用我配置的接口」，不是 Blab。
   *
   * Blab 那一档这里不预判能不能用（登录、订阅、今天的额度）：被钉成 blab 的请求
   * 照样发，由服务端回错，错误原样给用户看，不改用其他引擎（设计 §5.3）。
   */
  function forRequest(message) {
    const pinned = eng.pinnedEngine(message);
    const chosen = pinned !== undefined ? pinned : eng.selectedEngine(!!message.auto);
    const engine = globalThis.Engines.isModelEngine(chosen) ? chosen : 'ai';
    const resolved = engine === 'blab'
      ? { profile: globalThis.Engines.BLAB_PROFILE }
      : ctx.aiProfiles.resolve(message.feature);
    return { engine, resolved };
  }

  /**
   * 账户此刻能不能用 Blab Translation：billing/me 的 `blabTranslation.available`，
   * 只由服务端回答（D-476），这里不按套餐推断。走 SW 的 COMIC_ACCOUNT（30 秒缓存）。
   * 没登录、字段缺失都是不能用；问不到（网络、服务端错）也答不能用 —— 这是划词卡
   * 「换引擎」要不要提供这一项，提供一个点了只会报错的引擎比不提供更糟。问不到的
   * 那一下在这里记一次日志。
   */
  async function blabAvailable() {
    const response = await chrome.runtime.sendMessage({ type: 'COMIC_ACCOUNT' });
    if (!response || !response.ok) {
      const code = response && response.error ? response.error.code : 'no response';
      console.warn('Blab Translation: account check for Blab Translation failed (%s)', code);
      return false;
    }
    const account = response.data;
    return account.signedIn === true && !!account.blabTranslation && account.blabTranslation.available === true;
  }

  eng.model = { forRequest, blabAvailable };
})();
