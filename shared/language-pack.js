// Blab Translation — 端上引擎的语言包状态和下载，设置页与首装引导页共用。
//
// 语言包按「语言对」下载，而源语言取决于用户当时打开的是什么页面，扩展页面无从
// 预知。所以这里只对 en → 目标语言（现实里占绝大多数的那一对）给出状态和一个
// 下载按钮；其它语言对在整页翻译首次用到时自动下载 —— 那条路径带着用户点击产生
// 的 user activation，正是 create() 触发下载所要求的东西。
//
// 这里只答「是什么状态、该说哪句话」，不碰 DOM。「检查中…」的中间态和丢弃过期
// 结果的序号属于页面：两页的控件不一样，各自持有。
//
// 依赖（调用时才取）：EngineStatus、TargetLang、TabBroadcast。引擎对象由页面
// 传进来（window.AI_TRANSLATOR_CONTENT.builtinTranslator），这样 node 单测可以
// 直接喂一个假的。
(function (root) {
  'use strict';

  const PROBE_SOURCE = 'en';

  /**
   * 不用问 availability() 就已经知道的答案；需要问时返回 null。
   *
   * @returns {{key: string, lang?: string, downloadable: false}|null}
   */
  function describe(engine, { targetLang, engineFallback }) {
    if (!engine || !engine.isSupported()) {
      // 说清楚为什么。扩展页面本身永远是安全上下文，所以这里问出来的实际上只会
      // 是「Chrome 太旧」或「这个版本没有这个接口」—— 而那正是用户需要知道的：
      // 引擎选单把内置摆在第一位，不给理由就等于让他选一个不会动的东西。
      const reason = engine && engine.unsupportedReason && engine.unsupportedReason();
      return {
        key: root.EngineStatus.REASON_MESSAGE_KEYS[reason] || 'builtinUnsupportedEnv',
        downloadable: false,
      };
    }
    if (!engine.supportsTarget(targetLang)) {
      // 端上根本没有这门语言（「仅 AI」那 37 门）：答案已经知道，不交给
      // availability() —— 它对这类语言在不同 Chrome 上答法不一，还只能换来一句
      // 含糊的「这一对不支持」。按回退设置点名说清楚会发生什么。
      return {
        key: engineFallback === 'allow-ai' ? 'builtinTargetUnsupportedAllowAi' : 'builtinTargetUnsupportedLocalOnly',
        lang: targetLang,
        downloadable: false,
      };
    }
    // 目标语言就是英语，探测 en→en 没有意义。
    if (engine.toApiLang(targetLang) === PROBE_SOURCE) return { key: 'builtinReady', downloadable: false };
    return null;
  }

  const PROBE_ANSWERS = {
    available: { key: 'builtinReady', downloadable: false },
    downloading: { key: 'builtinDownloading', downloadable: false },
    downloadable: { key: 'builtinDownloadable', downloadable: true },
  };

  /** 问 availability()，把答案翻成一句话的键。 */
  async function probe(engine, targetLang) {
    const status = await engine.availability(PROBE_SOURCE, targetLang);
    return PROBE_ANSWERS[status] || { key: 'builtinUnsupportedPair', downloadable: false };
  }

  /** 状态 → 能直接显示的句子。`t` 是页面自己的取文案函数。 */
  function message(result, t, uiLang) {
    const text = t(result.key);
    if (!result.lang) return text;
    return text.replace('{lang}', root.TargetLang.nameOf(result.lang, uiLang, { inSentence: true }));
  }

  /**
   * 下载 en → targetLang 的语言包。必须在用户点击的那一刻直接调用：create()
   * 要求 user activation，挪到别处（比如打开页面就自动下）会被浏览器拒掉。
   *
   * 成功后告诉所有标签页；失败向上抛，由页面决定怎么显示。
   *
   * @param {(percent: number) => void} onPercent 0–100 的整数
   */
  async function download(engine, targetLang, onPercent) {
    await engine.ensureDownloaded(PROBE_SOURCE, targetLang, (loaded) => {
      onPercent(Math.max(0, Math.min(100, Math.round((loaded || 0) * 100))));
    });
    root.TabBroadcast.languagePackReady(PROBE_SOURCE, engine.toApiLang(targetLang));
  }

  root.LanguagePack = { PROBE_SOURCE, describe, probe, message, download };
})(globalThis);
