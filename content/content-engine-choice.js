// Blab Translation Content Script Engine Choice
//
// 「这次是谁译的、能换到谁」的唯一一份画法：划词卡片（content-popup.js 的
// settleCardActions）和输入框对话框（content-input-dialog.js）都调这里，谁也不
// 自己拼。分两步，因为两步的节奏不同：
//
// - showEngineTag(tag, engine) 同步写标签，调用方在第一个 await 之前就画完；
// - offerEngineSwitch({...}) 异步问另一边此刻能不能用，回来再定「换到…」按钮。
//
// 「换到…」按钮的初始标记也从这里出（engineSwitchLabel），按钮定宽用的字和
// offerEngineSwitch 写上去的字是同一张表。
//
// 两者挂在 ctx 上，调用方在调用时读（manifest 里本文件排在 content-popup.js 之前，
// 但谁也不靠这个顺序）。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const t = ctx.t;

  // 引擎标签与「换到…」按钮文字，每个引擎一条（Engines.ENGINES）。
  const ENGINE_TAG = { builtin: 'cardEngineBuiltin', ai: 'cardEngineAi', blab: 'cardEngineBlab' };
  const USE_ENGINE = { builtin: 'cardUseBuiltin', ai: 'cardUseAi', blab: 'cardUseBlab' };

  /**
   * tag 写上 engine 的标签；没有 engine（请求开始、扩展上下文没了、请求抛错）就
   * 清空并藏起来。
   *
   * @param {HTMLElement} tag
   * @param {(string|null|undefined)} engine
   */
  function showEngineTag(tag, engine) {
    tag.textContent = engine ? t(ENGINE_TAG[engine]) : '';
    tag.hidden = !engine;
  }

  /**
   * 「换到…」按钮里的文字 span：先空着，定宽按 engines 里每个引擎的「换到…」说法里
   * 最宽的那种（ctx.fitLabel）。engines 是这个按钮可能换到的引擎，调用方按自己能
   * 给出的列。
   *
   * @param {string[]} engines
   * @returns {string}
   */
  function engineSwitchLabel(engines) {
    return ctx.fitLabel('', engines.map((engine) => t(USE_ENGINE[engine])));
  }

  /**
   * 问另一边此刻能不能用（ctx.engineChoices，按 feature 解析 AI 档）：能用就露出
   * button、dataset.engine 记下换到谁、文字说换到哪边；不能用就藏。问的这一下要
   * await，回来时 isCurrent() 不再成立（又发了一次请求、卡片关了）就什么都不动——
   * 按钮停在原样，等下一次结算来定。
   *
   * 返回按钮上给出的那个引擎；没得换或已不是当前请求都是 null。对话框拿它决定
   * 「没得换」时露出「打开设置」。
   *
   * @param {{button: HTMLElement, engine: (string|null|undefined), targetLang: string,
   *   feature: string, isCurrent: () => boolean}} options
   * @returns {Promise<?string>}
   */
  async function offerEngineSwitch({ button, engine, targetLang, feature, isCurrent }) {
    const other = await switchOffer(engine, targetLang, feature);
    if (!isCurrent()) return null;
    button.hidden = !other;
    if (!other) return null;
    button.dataset.engine = other;
    button.querySelector('.ai-translator-btn-label').textContent = t(USE_ENGINE[other]);
    button.disabled = false;
    return other;
  }

  // 这次是 engine 答的，换到哪一个：按 Engines.ENGINES 的顺序取第一个「不是它、此刻
  // 又能接这个功能、这门目标语言」的引擎（内置在前，所以 ai 与内置之间的老行为不变）；
  // 一个都没有是 null。Blab 只在账户此刻能用时才给（设计 §5.4：不切到不可用的引擎）。
  async function switchOffer(engine, targetLang, feature) {
    if (!engine) return null;
    try {
      const choices = await ctx.engineChoices(targetLang, feature);
      return globalThis.Engines.ENGINES.find((other) => other !== engine && choices[other]) || null;
    } catch (error) {
      console.error('Blab Translation: reading engine choices failed', error);
      return null;
    }
  }

  ctx.engineSwitchLabel = engineSwitchLabel;
  ctx.showEngineTag = showEngineTag;
  ctx.offerEngineSwitch = offerEngineSwitch;
})();
