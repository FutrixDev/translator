// Blab Translation — 整页翻译：不是正文的字
//
// 收集器按标签收块：<span>、<button>、<td> 里有字就收。Reddit / X 的信息流里，这样
// 收进来的有两类不是给人读的正文（D-429）：
//
// - **只有数字和符号**：投票数「12」、比分「24」、规则序号「1」、「94.2%」。译出来还
//   是那几个数字，排在原文旁边就是同一个数写两遍。以前只在 <td>/<th> 上跳过，现在
//   对每一块都跳过——哪个标签装着，都不是要译的字。
// - **控件上的短标签**：「Share」「Join」「Follow」「Best」。它们排在一行 flex 里，
//   译文挂在右边，把整行挤歪；读者本来就认得这些按钮。认法是元素落在一个控件里
//   （<button> 或按钮 / 标签页 / 菜单项 / 选项 / 开关这几种 role），而那个控件自己
//   **看得见的**字很短：不过 30 个字符、不过 3 个词、没有句末标点。问控件整体而不是
//   这个元素，是因为整张卡片也会写成 role=button——卡片里的正文不能跟着按钮一起跳过。
//   控件里有标题、段落、列表项，它就是一张卡片，不是按钮：卡片里一句三个词的标题
//   照样要译。
//   中日韩文不用空格分词，两个字算一个词：「分享」「查看全部评论」是标签，一句
//   二十个字的标题不是。
//   <svg> 里的 <title>/<desc> 不画出来，不算看得见的字。
//   「看得见」要剔掉读屏说明：Reddit 的 <button>Share<faceplate-screen-reader-content>
//   Share this post with other people</…></button>，按 textContent 数就是 7 个词，
//   标签照样被译（判定同 content/page/reader-hidden.js）。
//
// 链接（<a>、role=link）不算控件：帖子标题、正文里的链接都是要读的字。
// collect.js 收块的两条路（内联标签、块级标签）都问这一处；命中就整块不收，不再往
// 下落到另一条路。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const CONTROL = 'button,[role=button],[role=tab],[role=menuitem],[role=menuitemradio],' +
    '[role=menuitemcheckbox],[role=option],[role=switch]';
  const LABEL_MAX_CHARS = 30;
  const LABEL_MAX_WORDS = 3;
  const CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;
  // 装着这些的控件是一张卡片。
  const PROSE_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'LI', 'BLOCKQUOTE']);
  // 句末标点后面跟空白或到头才算：「v1.2」里的点不是句号。
  const SENTENCE_END = /[.!?。！？](\s|$)/;

  // 至少一个数字，其余全是数字、空白和常见数值符号：0.83、94.2%、±0.02、1,234、24–17。
  // 要求有数字，免得「N/A」「—」这类被当成数字。
  function isNumericOrSymbolOnly(text) {
    const t = (text || '').trim();
    if (!/\d/.test(t)) return false;
    return /^[\d\s.,%±+\-*/()<>=:~×·°∓‰$€£¥–—]+$/.test(t);
  }

  // 控件上眼睛看得见的字（组合树，跳过 display:none、读屏说明、<svg> 和藏起来的
  // slot）；控件是一张卡片时答 null。超过上限就不必再读了：结论已经是「不是短标签」。
  function visibleLabel(control) {
    if (PROSE_TAGS.has(control.tagName)) return null;
    let text = '';
    let card = false;
    const walk = (el) => {
      for (const node of ctx.composedChildNodes(el)) {
        if (card || text.length > LABEL_MAX_CHARS * 2) return;
        if (ctx.inHiddenSlot(node)) continue;
        if (node.nodeType === Node.TEXT_NODE) {
          text += node.textContent;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') continue;
          if (node.tagName.toLowerCase() === 'svg') continue;
          if (PROSE_TAGS.has(node.tagName)) { card = true; return; }
          const style = window.getComputedStyle(node);
          if (style.display === 'none' || ctx.hiddenFromReaders(style)) continue;
          text += ' ';
          walk(node);
        }
      }
    };
    walk(control);
    return card ? null : text.replace(/\s+/g, ' ').trim();
  }

  // 空格分出的词，加上中日韩文的字数折半。
  function wordCount(text) {
    const cjk = (text.match(CJK) || []).length;
    const spaced = text.replace(CJK, ' ').split(' ').filter(Boolean).length;
    return spaced + Math.ceil(cjk / 2);
  }

  function isShortLabel(text) {
    return text !== null &&
      text.length <= LABEL_MAX_CHARS &&
      wordCount(text) <= LABEL_MAX_WORDS &&
      !SENTENCE_END.test(text);
  }

  // element：要收的块；plainText：它要送去翻译的字（已剥掉占位符和标记）。
  function notProse(element, plainText) {
    if (isNumericOrSymbolOnly(plainText)) return true;
    const control = ctx.closestComposed(element, CONTROL);
    return !!control && isShortLabel(visibleLabel(control));
  }

  ctx.notProse = notProse;
})();
