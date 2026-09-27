// Blab Translation —— 把译文写回用户正在写的那个输入框（D-352）。
//
// 「译成 X」芯片点下去之后，译文直接落进原来的框：多行的框（textarea、
// contenteditable）保留原文，在末尾换一行接上译文；单行的 input 没有「换行」
// 可言，用译文替换原文。两种都要能 Ctrl/Cmd+Z 一步撤回到原文。
//
// 这里只管「怎么写」，不管「什么时候写」—— 什么时候写、写之前要核对什么，是
// content/content-input-chip.js 的事。
//
// 写法只有一条：**像浏览器处理一次按键那样写**。
//
// 1. 先发一个可取消的 `beforeinput`（inputType + data，和敲字时浏览器发的一样）。
//    自己维护数据模型的编辑器（reddit 评论框的 Lexical 这一类）就在这一步接手：
//    取消事件、改自己的模型、自己重画 DOM。它接手了，我们就什么都不再做。
// 2. 没人接手，就让浏览器自己做：`document.execCommand('insertText')`。这一步
//    走的是浏览器原生的编辑命令，所以原生撤销栈记下的是一步，页面收到的是真正
//    的 `input` 事件，React 的受控组件照常同步。
//
// 直接改 value / innerText / innerHTML 是不行的：Draft、Lexical 这类编辑器下一次
// 重画就把它抹掉，发帖时模型里也没有这段字；原生输入框的撤销栈也不认它。
//
// 为什么要自己发 beforeinput：`execCommand` 本身**不发** beforeinput，只发
// input（e2e 里的 Chromium 实测），而这类编辑器只从 beforeinput 读意图 ——
// 光有 execCommand，它们看到的只是一段来历不明的 DOM 变化。
//
// 写完还要回头看一眼字是不是真的在框里。页面取消了 beforeinput 却什么都没做、
// 或者编辑器把我们的改动回滚了，都是「没写进去」，要报错，不能当成功。
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

  // 单行框：整段换成译文。多行框：光标放到末尾，接一行译文。
  function placeSelection(field, replace) {
    if (isTextControl(field)) {
      const end = field.value.length;
      field.setSelectionRange(replace ? 0 : end, end);
      return;
    }
    const selection = document.getSelection();
    const range = document.createRange();
    range.selectNodeContents(field);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function announce(field, data) {
    let targetRanges = [];
    if (!isTextControl(field)) {
      const selection = document.getSelection();
      if (selection && selection.rangeCount) {
        const range = selection.getRangeAt(0);
        targetRanges = [new StaticRange({
          startContainer: range.startContainer,
          startOffset: range.startOffset,
          endContainer: range.endContainer,
          endOffset: range.endOffset
        })];
      }
    }
    const event = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      composed: true,
      inputType: 'insertText',
      data,
      targetRanges
    });
    return !field.dispatchEvent(event);
  }

  // execCommand 在这个框上用不了时（它答 false），原生输入框还有最后一条路：
  // 用原型上的 value setter 设值 —— 绕过 React 在实例上装的那一层 —— 再发一个
  // input，受控组件才会把新值收进自己的 state。contenteditable 没有这条路。
  function setNativeValue(field, value, data) {
    const proto = field.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, value);
    field.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      composed: true,
      inputType: 'insertText',
      data
    }));
  }

  const squash = (text) => String(text).replace(/\s+/g, '');

  // 编辑器接手 beforeinput 之后，可能在微任务里才把模型画回 DOM（Lexical 就是）。
  // 等一个宏任务再看，才看得到它画完的样子。
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  /**
   * 把译文写进 field。单行 input 替换原文；其余在末尾换一行追加。
   * 没写进去就抛 —— 调用方把它当成一次失败，框里的字保持原样。
   */
  async function write(field, translation) {
    const text = String(translation || '').trim();
    if (!text) throw new Error('input writeback: empty translation');

    const replace = field.tagName === 'INPUT';
    const current = fieldText(field);
    const data = replace || current.endsWith('\n') ? text : `\n${text}`;
    const expected = replace ? text : current + data;

    placeSelection(field, replace);
    if (!announce(field, data)) {
      const inserted = document.execCommand('insertText', false, data);
      if (!inserted) {
        if (!isTextControl(field)) throw new Error('input writeback: insertText refused');
        setNativeValue(field, expected, data);
      }
    }

    await settle();
    if (!squash(fieldText(field)).includes(squash(text))) {
      throw new Error('input writeback: the field did not take the translation');
    }
  }

  ctx.inputWriteback = { fieldText, hasFocus, write };
})();
