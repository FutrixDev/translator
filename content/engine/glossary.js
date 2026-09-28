// Blab Translation 翻译引擎 —— 词表快照、匹配器与内置引擎的占位保护
//
// 词条从哪来是 content/content-glossary.js（ctx.glossary，顶层帧的镜像）的事；
// 这一份只回答「这一次请求用哪些词条、它们命中了哪几段文字」，以及内置引擎那条
// 路上怎么把命中的词条换成占位符再换回来。AI 那条路的附加说明怎么拼、怎么按
// 60 条切份，在 content/engine/addenda.js。
//
// 快照（current(targetLang)）在请求开始时取一次，不可变：这一次请求的缓存键、
// 提示词、占位符都出自同一份。请求在途时词表变了，只影响下一次请求。
//
// 没有 ctx.glossary 的地方（设置页、子帧、Node 测试台）快照是空的：那里本来就
// 没有词表，不是出错后的兜底。
(function() {
  'use strict';

  if (globalThis.FrameEligibility && !globalThis.FrameEligibility.shouldActivate()) return;
  const ctx = window.AI_TRANSLATOR_CONTENT || (window.AI_TRANSLATOR_CONTENT = {});
  // 这一族共用的架子，说明见 content/content-translation-engine.js 顶上。
  const eng = (ctx.engine = ctx.engine || {});

  // 内置引擎一段最多换这么多个占位符（§7）：NMT 对一串 {{n}} 越来越不老实，
  // 第 21 个起按原文送，由引擎自己译。
  const MAX_PLACEHOLDERS = 20;

  // 词边界只加在需要的一侧：首（末）字符属于这一类才加。拉丁、西里尔、希腊三种
  // 文字的字母，加数字和组合记号 —— 「GPT-4」两头都要，「注意力」两头都不要，
  // 「C++」只有前面要。
  const WORD_CLASS = '[\\p{Script=Latin}\\p{Script=Cyrillic}\\p{Script=Greek}\\p{Nd}\\p{M}]';
  const WORD_CHAR = new RegExp(`^${WORD_CLASS}$`, 'u');

  // 带 u 标志时只许转义语法字符，`\-` 这类身份转义是语法错误。
  function escapeLiteral(s) {
    return s.replace(/[\^$\\.*+?()[\]{}|/]/g, '\\$&');
  }

  function entryPattern(source) {
    const body = source.split(' ').map(escapeLiteral).join('\\s+');
    const chars = Array.from(source);
    const before = WORD_CHAR.test(chars[0]) ? `(?<!${WORD_CLASS})` : '';
    const after = WORD_CHAR.test(chars[chars.length - 1]) ? `(?!${WORD_CLASS})` : '';
    return `${before}(${body})${after}`;
  }

  function byLengthThenText(a, b) {
    return b.s.length - a.s.length || (a.s < b.s ? -1 : a.s > b.s ? 1 : 0);
  }

  // 一组词条编成一个正则：每条一个捕获组，命中哪组就是哪条。不用正则的内联
  // 大小写修饰符（Chrome 125 才有，manifest 的 minimum_chrome_version 是 116），
  // 区分和不区分大小写各编一个；单测扫描这一族里没有那种写法。
  function compileGroup(entries, flags) {
    if (!entries.length) return null;
    const ordered = entries.slice().sort(byLengthThenText);
    return {
      re: new RegExp(ordered.map((entry) => entryPattern(entry.s)).join('|'), flags),
      entries: ordered,
    };
  }

  function execFrom(group, value, p) {
    if (!group) return null;
    group.re.lastIndex = p;
    const m = group.re.exec(value);
    if (!m) return null;
    let i = 1;
    while (m[i] === undefined) i += 1;
    return { start: m.index, end: m.index + m[0].length, entry: group.entries[i - 1] };
  }

  // 最左；起点相同取长的；再相同取区分大小写的（a 是区分大小写那一组的命中）。
  function better(a, b) {
    if (!a) return b;
    if (!b) return a;
    if (a.start !== b.start) return a.start < b.start ? a : b;
    return b.end - b.start > a.end - a.start ? b : a;
  }

  // 同一条词条在规范串和附加说明里只说一次；没有 t 就是「保留原文」。
  function canonical(entry) {
    return JSON.stringify([entry.c ? 1 : 0, entry.s, entry.t === undefined ? null : entry.t]);
  }

  function maxPlaceholderId(text) {
    let max = 0;
    for (const id of globalThis.TextMarkers.placeholderIds(text)) max = Math.max(max, Number(id));
    return max;
  }

  const counters = { protectedSegments: 0, placeholderLosses: 0 };

  /**
   * 由已经挑好的词条（Glossary.pick 的结果）建一个快照。`key` 只用来记忆。
   * 快照的成员见设计 §3.3；空表得到的快照什么也不做。
   */
  function fromEntries(entries, key) {
    const sensitive = compileGroup(entries.filter((entry) => entry.c), 'gu');
    const insensitive = compileGroup(entries.filter((entry) => !entry.c), 'giu');

    function scan(value, offset, hits) {
      let p = 0;
      while (p < value.length) {
        const hit = better(execFrom(sensitive, value, p), execFrom(insensitive, value, p));
        if (!hit) return;
        hits.push({ start: offset + hit.start, end: offset + hit.end, entry: hit.entry });
        p = hit.end;
      }
    }

    // 只在文字片段里匹配：占位符和标记是别人的，词条不能跨进去。
    function match(text) {
      if (!entries.length) return [];
      const hits = [];
      let offset = 0;
      for (const segment of globalThis.TextMarkers.segments(String(text == null ? '' : text))) {
        if (segment.kind === 'text') scan(segment.value, offset, hits);
        offset += segment.value.length;
      }
      return hits;
    }

    function stamp(text) {
      const parts = Array.from(new Set(match(text).map((hit) => canonical(hit.entry))));
      return parts.sort().join(',');
    }

    function protect(text, firstId) {
      const source = String(text == null ? '' : text);
      const hits = match(source).slice(0, MAX_PLACEHOLDERS);
      if (!hits.length) return { text: source, ids: [], restore: (out) => out };
      const back = new Map();
      let out = '';
      let last = 0;
      hits.forEach((hit, k) => {
        const id = String(firstId + k);
        const original = source.slice(hit.start, hit.end);
        back.set(id, hit.entry.t === undefined ? original : hit.entry.t);
        out += source.slice(last, hit.start) + globalThis.TextMarkers.placeholder(id);
        last = hit.end;
      });
      out += source.slice(last);
      return {
        text: out,
        ids: Array.from(back.keys()),
        // 有译文的换成译文，「保留原文」的换回页面上的原样写法；数学占位符不动。
        restore: (translated) => String(translated).replace(
          globalThis.TextMarkers.placeholderPattern(),
          (whole, id) => (back.has(id) ? back.get(id) : whole),
        ),
      };
    }

    const snap = {
      version: key,
      entries,
      match,
      stamp,
      plan: (texts) => eng.addenda.plan(snap, texts),
      protect,
    };
    return Object.freeze(snap);
  }

  const EMPTY = fromEntries([], 'empty');
  let memo = EMPTY;

  /**
   * 这一次请求的快照。先等镜像到位（ctx.glossary.whenReady，最多 1500 ms），
   * 再按「镜像版本 × 目标语言 × 顶层主机」取：同一组合只编译一次，记住最近一个。
   */
  async function current(targetLang) {
    if (!ctx.glossary) return EMPTY;
    await ctx.glossary.whenReady();
    const host = location.hostname;
    const key = `${ctx.glossary.version}|${targetLang || ''}|${host}`;
    if (memo.version === key) return memo;
    const picked = globalThis.Glossary.pick(ctx.glossary.entries(), host, targetLang);
    memo = picked.length ? fromEntries(picked, key) : Object.freeze({ ...EMPTY, version: key });
    return memo;
  }

  /**
   * 内置引擎的一段：命中的词条先换成占位符再送（源语言仍按原文判，见 detectText），
   * 回来再换回去。引擎原样吐回保护后的文字（同语言、或者没译）时返回原文。
   *
   * 词表的占位符丢了：记一次日志、计数，然后不带词表把原文再译一次 —— 引擎戳还是
   * builtin，不花 AI 额度，不是回落。只丢了数学占位符、或者重译又丢了，原样往上抛。
   *
   * @param {object} snap current() 的快照
   * @param {string} text 原文
   * @param {(text: string, extra: {detectText?: string}) => Promise<string>} run
   */
  async function withGlossary(snap, text, run) {
    const source = String(text == null ? '' : text);
    const guarded = snap.protect(source, maxPlaceholderId(source) + 1);
    if (!guarded.ids.length) return run(source, {});
    counters.protectedSegments += 1;
    let translated;
    try {
      translated = await run(guarded.text, { detectText: source });
    } catch (error) {
      const lost = error instanceof eng.PlaceholderLossError ? error.lost : [];
      if (!lost.some((id) => guarded.ids.includes(id))) throw error;
      counters.placeholderLosses += 1;
      console.warn('Blab Translation: builtin translator dropped glossary placeholders', { lost });
      return run(source, {});
    }
    if (translated === guarded.text) return source;
    return guarded.restore(translated);
  }

  /** 只给测量脚本和单测读（§6.3）。 */
  function stats() {
    return {
      protectedSegments: counters.protectedSegments,
      placeholderLosses: counters.placeholderLosses,
      overflowEntries: eng.addenda.overflowEntries(),
    };
  }

  eng.glossary = { current, fromEntries, withGlossary, stats, MAX_PLACEHOLDERS };
})();
