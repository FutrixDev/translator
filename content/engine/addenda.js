// Blab Translation 翻译引擎 —— AI 请求的附加说明：怎么拼、怎么切份、缓存戳
//
// 附加说明的形状和上限在 shared/prompt-addenda.js（PromptAddenda），服务工作者按
// 同一份上限把关；这里只负责按快照（content/engine/glossary.js）把一批文字切成
// 几份、给每一份拼出它的 `addenda`。发出去是 content-translation-engine.js 的
// sendToModel，一份一份依次发。
//
// 三样东西：
//   - 词表：这一份文字命中的词条（快照切份时算好）。
//   - 领域：有效领域 = 本站规则的 domain（ctx.customRules.domain()）?? 全局
//     settings.promptDomain。规则写「general」也算写了；有效领域是 general 就不发。
//   - 页面上下文：只在 settings.aiPageContext 开着、而且不是输入框（standaloneText）
//     时附带。标题是执行请求的这一帧（顶层）的 document.title；前后文只有整页批量
//     有，由 content/page/batch.js 放进消息的 `pageContext: {before, after}`。这里
//     先过 TextMarkers.strip 再按 PromptAddenda.LIMITS 截：before 取最后 300 字，
//     after 取前 300 字，标题取前 200 字。`pageContext` 从不发给模型：执行请求的
//     那一帧的引擎（content-translation-engine.js 的 sendToModel）在发出前把它从消息
//     上剥掉，内置引擎从来不看它。子 frame 的请求整条经 SW 中继转给顶层帧
//     （frames/child.js 的 requestViaTop），`pageContext` 随消息过 SW，到顶层才剥。
//
// 这里读 ctx.settings / ctx.customRules 都在调用时读。设置页也加载这一族，但从不
// 调 plan / compose / stamp，所以那里没有 ctx.customRules 也无妨；内容脚本里
// ctx.customRules 一定在（content/page/custom-rule.js 装），不做空值兜底。
//
// 不认得的领域（存储里的值不在 PromptAddenda.DOMAINS 里）是配置错：这一页之后的
// 每一次 AI 请求都会一样失败。抛出的错误带 `passFatal: true` 和给用户看的文案，
// 整页一轮（content/page/batch.js）见到它第一次就停下并报出来，不再等累计阈值；
// 子 frame 经顶层中继（frames/top.js）时这个标记随 {error} 一起带回。
(function() {
  'use strict';

  if (globalThis.FrameEligibility && !globalThis.FrameEligibility.shouldActivate()) return;
  const ctx = window.AI_TRANSLATOR_CONTENT || (window.AI_TRANSLATOR_CONTENT = {});
  // 这一族共用的架子，说明见 content/content-translation-engine.js 顶上。
  const eng = (ctx.engine = ctx.engine || {});

  let overflow = 0;

  function entryKey(entry) {
    return JSON.stringify([entry.c ? 1 : 0, entry.s, entry.t === undefined ? null : entry.t]);
  }

  // 一段文字命中的词条，按命中次数降序、次数相同按首次出现排。
  function rankedHits(snap, text) {
    const byKey = new Map();
    snap.match(text).forEach((hit, order) => {
      const key = entryKey(hit.entry);
      const seen = byKey.get(key);
      if (seen) seen.count += 1;
      else byKey.set(key, { key, entry: hit.entry, count: 1, order });
    });
    return Array.from(byKey.values()).sort((a, b) => b.count - a.count || a.order - b.order);
  }

  function toAddendaEntry(entry) {
    return entry.t === undefined ? { s: entry.s } : { s: entry.s, t: entry.t };
  }

  function finish(part) {
    return { indices: part.indices, glossary: Array.from(part.entries.values()).map(toAddendaEntry) };
  }

  /**
   * 按 60 条上限（PromptAddenda.LIMITS.entries）把一批文字切成几份：按文字顺序往
   * 一份里装，装进下一段会让这一份的词条并集超过上限，就开新的一份。一段文字自己
   * 就命中超过上限时单独成一份，只带命中次数最多的那些，舍掉的条数记进
   * overflowEntries。没有命中时只有一份、不带词表。
   *
   * @returns {{indices: number[], glossary: {s: string, t?: string}[]}[]}
   */
  function plan(snap, texts) {
    const max = globalThis.PromptAddenda.LIMITS.entries;
    const parts = [];
    let part = null;
    texts.forEach((text, index) => {
      let hits = rankedHits(snap, text);
      if (hits.length > max) {
        overflow += hits.length - max;
        hits = hits.slice(0, max);
        if (part) parts.push(part);
        parts.push({ indices: [index], entries: new Map(hits.map((hit) => [hit.key, hit.entry])) });
        part = null;
        return;
      }
      const fresh = part ? hits.filter((hit) => !part.entries.has(hit.key)).length : hits.length;
      if (part && part.entries.size + fresh > max) {
        parts.push(part);
        part = null;
      }
      if (!part) part = { indices: [], entries: new Map() };
      part.indices.push(index);
      for (const hit of hits) if (!part.entries.has(hit.key)) part.entries.set(hit.key, hit.entry);
    });
    if (part) parts.push(part);
    if (!parts.length) return [{ indices: [], glossary: [] }];
    return parts.map(finish);
  }

  /**
   * 有效领域：本站规则钉住的优先，没有就是全局设置。不认得的 id 抛一个整轮致命的
   * 错误（见文件头），文案给用户看；坏值本身挂在 `domain` 上，给日志用。
   */
  function effectiveDomain() {
    const domain = ctx.customRules.domain() ?? ctx.settings.promptDomain;
    if (!globalThis.PromptAddenda.DOMAINS.includes(domain)) {
      const error = new Error(ctx.t('promptDomainUnknown'));
      error.name = 'PromptDomainError';
      error.passFatal = true;
      error.domain = domain;
      throw error;
    }
    return domain;
  }

  function contextWanted(message) {
    return ctx.settings.aiPageContext === true && message.standaloneText !== true;
  }

  /** 页面上下文：标题 + 前后文，先去标记再截到上限。没有邻段的一侧是空串。 */
  function pageContextOf(message) {
    const { LIMITS } = globalThis.PromptAddenda;
    const strip = (value) => globalThis.TextMarkers.strip(String(value || ''));
    const neighbours = message.pageContext || {};
    const before = strip(neighbours.before);
    return {
      title: strip(document.title).slice(0, LIMITS.title),
      before: before.length > LIMITS.before ? before.slice(-LIMITS.before) : before,
      after: strip(neighbours.after).slice(0, LIMITS.after),
    };
  }

  /**
   * 一份的附加说明；什么都没有时是 null，消息里的 `addenda` 就只有发起请求那一帧
   * 盖的语域（引擎的 withAddenda 把这里的结果并进去，不覆盖语域）。`message` 是
   * 这次要发的消息（读 standaloneText 与 pageContext），`part` 是 plan 切出的一份。
   * 批量切成几份时每份都带同一份上下文（每份是一次独立的模型调用），各自计字数。
   */
  function compose(message, part) {
    const addenda = {};
    if (part.glossary.length) addenda.glossary = part.glossary;
    const domain = effectiveDomain();
    if (domain !== 'general') addenda.domain = domain;
    if (contextWanted(message)) addenda.context = pageContextOf(message);
    return Object.keys(addenda).length ? addenda : null;
  }

  /**
   * 缓存键的第八个因子（shared/translation-cache.js 的 `addenda`）：只放决定「这段
   * 怎么译」的东西 —— 这段命中的词条、有效领域、上下文开关。上下文只进开关不进
   * 内容：前后文每段都不一样，放进键里就等于不缓存。
   */
  function addendaStamp(snap, text) {
    return `${snap.stamp(text)}|d:${effectiveDomain()}|c:${ctx.settings.aiPageContext === true ? 1 : 0}`;
  }

  eng.addenda = { plan, compose, stamp: addendaStamp, overflowEntries: () => overflow };
})();
