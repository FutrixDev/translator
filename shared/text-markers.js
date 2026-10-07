// Blab Translation — 占位符与内联标记的语法（唯一写入点）
//
// 送翻的文字里有两种不是正文的记号：
//   - 占位符 `{{n}}`：数学公式、词表保护的词条，译完按编号换回去；
//   - 内联标记 `<a1>…</a1>`：超链接、粗体这类内联元素，译完按标签名 + 编号
//     克隆原元素重建（见 content/page/insert.js 的 buildTranslationContent）。
//
// 它们的正则曾经散在八个文件里，各抄一份。这里是唯一的一份：生成、匹配、解析、
// 剥离、切片都问这个模块，test/unit/text-markers.test.mjs 扫描全仓，别处再写出
// 这两种记号的正则字面量就红。
//
// 两件事分开导出：
//   - 通用语法（markerPattern 等）回答「这是不是一个标记」，给分析用——代码检测、
//     长度阈值、语言检测、原文译文比对。结果不落到页面上，多剥少剥伤不到读者。
//   - debrisScrubber(markupElements) 回答「这一块该删哪些残片」，给渲染用，只认
//     本块真正生成过的标签名和编号。讲 HTML 的页面正文里就写着 <b2> 这类字样，
//     用笼统的那条会把页面自己的字删掉。
//
// 双模经典脚本：内容脚本和设置页用 <script> 装它，服务工作者和单测 import 它，
// 都从 globalThis.TextMarkers 取。没有依赖。
(function (root) {
  'use strict';

  // ==================== 占位符 {{n}} ====================

  function placeholder(n) {
    return `{{${n}}}`;
  }

  // 每次调用返回新的全局正则：模块级共享一个 /g 实例，两处交错 exec 会互相
  // 改 lastIndex。正则字面量每求值一次就是一个新对象。
  function placeholderPattern() {
    return /\{\{(\d+)\}\}/g;
  }

  // 只认整串（一个占位符，前后没有别的字），返回编号字符串，不是就返回 null。
  function parsePlaceholder(s) {
    const m = /^\{\{(\d+)\}\}$/.exec(String(s));
    return m ? m[1] : null;
  }

  // 文字里出现过的全部占位符编号（字符串）。
  function placeholderIds(text) {
    const ids = new Set();
    const re = placeholderPattern();
    const source = String(text || '');
    let match;
    while ((match = re.exec(source)) !== null) {
      ids.add(match[1]);
    }
    return ids;
  }

  // 把译文里掉了花括号的占位符补回 `{{n}}`，返回补好的译文。
  //
  // 实测（2026-10-07，Chrome 内置 Translator en→pt，7 个真页面）：带占位符的块有
  // 22% 丢了至少一个，31 个丢失全是掉括号——30 个 `{n}}`、1 个 `{n}`；前一轮实验
  // 里相邻的 `}}{{` 还出过 `{{n}`。占位符紧贴在非空白字符后面（`.{{1}}`、
  // `(Smith){{1}}`、`<a1>{{1}}</a1>`）最常掉，前面是空格也会掉。不补的话整块按
  // 丢了公式判失败（content/content-translation-engine.js 的 keepsPlaceholders）。
  //
  // 只补本块真发出去、译文里又找不到完整写法的编号：页面正文自己就可能写着
  // `{2}}`（JSON、LaTeX 源码），原文里（去掉占位符以后）出现过的同样写法也不碰。
  // 编号整段取出再比，所以 `{{12}}` 不会被当成 `{{1` 的残片。
  function repairPlaceholders(source, translated) {
    const out = String(translated);
    const intact = placeholderIds(out);
    const lost = new Set([...placeholderIds(source)].filter((id) => !intact.has(id)));
    if (lost.size === 0) return out;
    const prose = String(source).replace(placeholderPattern(), '');
    return out.replace(/\{\{?(\d+)\}\}?/g, (shape, id) =>
      (lost.has(id) && !prose.includes(shape) ? placeholder(id) : shape));
  }

  // ==================== 内联标记 <a1>…</a1> ====================

  function openTag(name, i) {
    return `<${name}${i}>`;
  }

  function closeTag(name, i) {
    return `</${name}${i}>`;
  }

  // 严格形状：分析前的剥离用它。大小写不敏感不能丢——实测内置 NMT（Chrome
  // Translator，en→zh-Hans）会把开标记 `<a1>` 大写成 `<A1>`，闭标记仍是小写；
  // 少了 i 就漏剥。每次调用返回新实例，理由同 placeholderPattern。
  function markerPattern() {
    return /<\/?[a-z]+\d+>/gi;
  }

  // 宽松解析：模型改了大小写、在尖括号里塞了空白也认，免得多一个空格就把链接
  // 丢了。分组：1 = '/' 或 ''，2 = 标签名，3 = 编号。每次调用返回新实例。
  function markerParsePattern() {
    return /<\s*(\/?)\s*([a-z]+)\s*(\d+)\s*>/gi;
  }

  // 清掉解析后仍留在译文里的标记残骸（配不上任何一对、重建时只能原样跳过的
  // 标记），返回 (text) => text。两种残骸：
  //   - 串号：模型把 <a1>/<strong2> 串成了 <strong1>；
  //   - 粘号：模型把编号叠写或把相邻标记粘成一个。实测内置引擎把 Reddit 卡片
  //     头的 <span11> 写成了 <span1111>，四个数字配不上任何一个编号，原样显示
  //     给了读者。
  // 只认本块**真正生成过**的标签名，编号那一段要能整个拆成本块发过的编号
  // （1111 = 11·11）——这是为了不动页面正文：讲 HTML 的页面正文里就写着 <b2>
  // 这类字样，我们没生成过 b 标记时它一个字都不该被删。
  // 拆分放在替换回调里做，不写进正则：`(?:1|11|…)+` 这种编号互为前缀的交替
  // 遇上一长串数字会指数回溯。
  function debrisScrubber(markupElements) {
    if (!markupElements || markupElements.length === 0) return (text) => text;
    const tags = new Set(markupElements.map((mk) => mk.tag));
    const nums = new Set(markupElements.map((mk) => String(mk.index)));
    const widest = Math.max(...[...nums].map((n) => n.length));
    // ok[end]：digits 的前 end 位能拆成本块的编号
    const splitsIntoOwnNumbers = (digits) => {
      const ok = [true];
      for (let end = 1; end <= digits.length; end++) {
        ok[end] = false;
        for (let start = Math.max(0, end - widest); start < end && !ok[end]; start++) {
          ok[end] = ok[start] && nums.has(digits.slice(start, end));
        }
      }
      return ok[digits.length];
    };
    const re = markerParsePattern();
    return (text) => text.replace(re, (marker, slash, tag, digits) =>
      (tags.has(tag.toLowerCase()) && splitsIntoOwnNumbers(digits) ? '' : marker));
  }

  // ==================== 剥离、分段、切片 ====================

  // 文字里有没有落笔时会被当成结构的记号：占位符按 placeholderPattern、标记按
  // 宽松的 markerParsePattern 认 —— 和 content/page/insert.js 重建译文时认的是
  // 同两条，所以这里说「没有」，落笔就不会把它当成公式或页面元素。用户写的
  // 字（术语表词条）靠它拒收，不转义（D-387）。
  function hasMarkers(text) {
    const source = String(text || '');
    return placeholderPattern().test(source) || markerParsePattern().test(source);
  }

  // 去掉占位符和标记，给上下文、计数和语言检测用。空白不动，调用方各自收拾。
  function strip(text) {
    if (!text) return '';
    return String(text).replace(placeholderPattern(), '').replace(markerPattern(), '');
  }

  // 按占位符和（严格形状的）标记切成片段，[{kind: 'text'|'placeholder'|'marker',
  // value}]，把 value 依次拼回去等于原文。词表只在 text 片段里匹配。
  function segments(text) {
    const source = String(text || '');
    const out = [];
    const re = new RegExp(`${placeholderPattern().source}|${markerPattern().source}`, 'gi');
    let last = 0;
    let match;
    while ((match = re.exec(source)) !== null) {
      if (match.index > last) out.push({ kind: 'text', value: source.slice(last, match.index) });
      out.push({ kind: match[1] !== undefined ? 'placeholder' : 'marker', value: match[0] });
      last = re.lastIndex;
    }
    if (last < source.length) out.push({ kind: 'text', value: source.slice(last) });
    return out;
  }

  // 在 at 处切开时不把占位符切成两半：at 落在某个 `{{n}}` 内部（`{{` 之后、
  // `}}` 之前），就退到它的 `{{` 处；否则原样返回 at。
  function splitSafe(text, at) {
    const source = String(text || '');
    if (at <= 0 || at >= source.length) return at;
    const re = placeholderPattern();
    let match;
    while ((match = re.exec(source)) !== null) {
      if (match.index >= at) break;
      if (at < match.index + match[0].length) return match.index;
    }
    return at;
  }

  root.TextMarkers = Object.freeze({
    placeholder,
    placeholderPattern,
    parsePlaceholder,
    placeholderIds,
    repairPlaceholders,
    openTag,
    closeTag,
    markerPattern,
    markerParsePattern,
    debrisScrubber,
    hasMarkers,
    strip,
    segments,
    splitSafe,
  });
})(globalThis);
