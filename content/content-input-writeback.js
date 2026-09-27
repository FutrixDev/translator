// Blab Translation —— 把译文写回用户正在写的那个输入框（D-352，写法按 D-357）。
//
// 「译成 X」芯片点下去之后，译文直接落进原来的框：多行的框（textarea、
// contenteditable）保留原文，在末尾换一行接上译文；单行的 input 没有「换行」
// 可言，用译文替换原文。两种都要能 Ctrl/Cmd+Z 一步撤回到原文。
//
// 这里只管「怎么写」，不管「什么时候写」—— 什么时候写、写之前要核对什么，是
// content/content-input-chip.js 的事。
//
// 写法按框的种类分两条，各自只有一条：
//
// - 原生 textarea / input：选区放好，`document.execCommand('insertText')`。走的是
//   浏览器原生编辑命令：原生撤销栈记一步，页面收到一个真正的 `input` 事件
//   （inputType insertText；Chromium 的 execCommand 不发 beforeinput），React 受控
//   组件照常同步。它答 false 就是没写，抛错。
// - contenteditable：光标放到末尾，派发一次合成的 `paste`（DataTransfer 里
//   text/plain = 要接上的那段字）。Draft.js（x.com 发帖框）、Lexical（reddit 评论
//   框）都取消这次 paste、把字写进自己的模型、自己重画 DOM、自己记一步撤销 ——
//   **页面接了 paste，写不写、怎么写就是页面的事**，我们不再碰 DOM，事后只核对
//   结果。页面没接（没人 preventDefault：普通 contenteditable），合成的 paste 没有
//   默认动作，这时才退到 execCommand insertText，由浏览器写；换行的那一段在
//   Chromium 里可能拆成不止一个 input 事件。
//
// 为什么 contenteditable 不直接 execCommand（c5d37ea 就是这么做的，D-357）：Draft
// 不看原生 beforeinput，execCommand 插入带换行的字时 Chromium 把整个块连同
// data-offset-key 一起复制一份，Draft 的 editOnInput 按光标所在的那个块从 DOM 反推
// 模型，原文被冲掉、译文出现两份、撤销也乱了。paste 是这两种编辑器都认的「外来
// 文字」入口（主控在真 Draft、真 Lexical 上亲测，见 evidence/r33/b/controller-walk）。
//
// 直接改 value / innerText / innerHTML 是不行的：Draft、Lexical 这类编辑器下一次
// 重画就把它抹掉，发帖时模型里也没有这段字；原生输入框的撤销栈也不认它。
//
// 写之前：原生框设了 maxlength、写完会超长的，一个字都不碰，直接报错 —— 否则
// 浏览器会悄悄截断，用户得到半截译文。
//
// 写完回头看一眼：框里的字（压掉空白后）必须**正好等于**预期的「原文 + 译文」
// （单行框是「译文」）。只看「包含译文」不够：译文恰好是原文的一段时，页面取消了
// paste 却什么都没写也会被当成成功。
//
// 核对失败不等于没写：编辑器可能晚一拍才把字画进来。这一次预期的样子记下来
// （landed），下一次芯片被点、或者框被重新判定时先看一眼 —— 字已经在了，就当写成
// 了，绝不再追加一份。
//
// 翻译请求本身没有超时：请求一直不回，芯片就一直是「翻译中」，直到用户接着敲字、
// 按 Esc、或者离开这个框（芯片那边收回）。
(function () {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  function isTextControl(field) {
    return field.tagName === 'TEXTAREA' || field.tagName === 'INPUT';
  }

  // 框里现在的字。芯片判语言、点击时拍快照、结果回来时核对，读的都是这一份。
  function fieldText(field) {
    if (!field) return '';
    if (isTextControl(field)) return field.value || '';
    return field.innerText || field.textContent || '';
  }

  // 焦点到底落在谁身上。输入框在 shadow root 里时（reddit 的评论框），
  // document.activeElement 只是那个 shadow host。
  function deepActiveElement() {
    let active = document.activeElement;
    while (active && active.shadowRoot && active.shadowRoot.activeElement) {
      active = active.shadowRoot.activeElement;
    }
    return active;
  }

  function hasFocus(field) {
    const active = deepActiveElement();
    return !!active && (active === field || field.contains(active));
  }

  const squash = (text) => String(text).replace(/\s+/g, '');

  // 宏任务边界。两处要等：
  // - 光标挪到末尾之后、派发 paste 之前：Draft、Lexical 的模型选区是从
  //   selectionchange 里学来的，而 selectionchange 是异步排进来的。不等，它们会把
  //   字插在用户原来的光标处。
  // - 写完之后、核对之前：编辑器可能在微任务里才把模型画回 DOM（Lexical 就是）。
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  function caretToEnd(field) {
    const selection = document.getSelection();
    const range = document.createRange();
    range.selectNodeContents(field);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // true = 页面接了这次 paste（preventDefault），字由它来写。
  function offerPaste(field, data) {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', data);
    const event = new ClipboardEvent('paste', {
      clipboardData,
      bubbles: true,
      cancelable: true,
      composed: true
    });
    return !field.dispatchEvent(event);
  }

  function insertText(data) {
    if (!document.execCommand('insertText', false, data)) {
      throw new Error('input writeback: insertText refused');
    }
  }

  // 核对没过的那一次，框里「本该是」的样子。见文件头「核对失败不等于没写」。
  const missed = new WeakMap();

  /**
   * 上一次核对没过的写入，现在是不是已经落进框里了。是就忘掉这条记录并答 true
   * —— 调用方把它当成一次写成，不再发请求、不再追加。
   */
  function landed(field) {
    if (!missed.has(field)) return false;
    if (squash(fieldText(field)) !== squash(missed.get(field))) return false;
    missed.delete(field);
    return true;
  }

  /**
   * 把译文写进 field。单行 input 替换原文；其余在末尾换一行追加。
   * 写不了（超长、浏览器拒绝）就抛，框里的字不动；写了但核对没过也抛，这时框里
   * 可能已经变了 —— 见 landed()。
   */
  async function write(field, translation) {
    const text = String(translation || '').trim();
    if (!text) throw new Error('input writeback: empty translation');
    missed.delete(field);

    const replace = field.tagName === 'INPUT';
    const current = fieldText(field);
    const data = replace || current.endsWith('\n') ? text : `\n${text}`;
    const expected = replace ? text : current + data;

    if (isTextControl(field)) {
      if (field.maxLength >= 0 && expected.length > field.maxLength) {
        throw new Error('input writeback: the translation exceeds maxlength');
      }
      field.setSelectionRange(replace ? 0 : current.length, current.length);
      insertText(data);
    } else {
      caretToEnd(field);
      await settle();
      if (!offerPaste(field, data)) insertText(data);
    }

    await settle();
    if (squash(fieldText(field)) !== squash(expected)) {
      missed.set(field, expected);
      throw new Error('input writeback: the field does not read as expected');
    }
  }

  ctx.inputWriteback = { fieldText, hasFocus, landed, write };
})();
