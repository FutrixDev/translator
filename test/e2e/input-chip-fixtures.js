// 输入框芯片 e2e 用的那一页，和页上的两种仿制编辑器（test/e2e/input-chip.spec.js）。
//
// 两个编辑器都写成真正的函数，再用 toString() 塞进页面脚本：这样它们就是普通的
// 源码，不用在模板字符串里一层层转义。它们跑在页面里，不许引用这个文件里的任何
// 东西。
//
// 仿的编辑器形状只有下面这些：
//
// - mountModelEditor：Lexical 的形状（reddit 评论框）。模型是一串字，只从
//   beforeinput 读意图（取消它、自己改模型），接 paste（取消它、把 text/plain 接到
//   模型末尾），每次改完从模型重画 DOM，撤销栈是模型快照。模型之外的 DOM 改动在
//   下一次 input 时被重画抹掉。pasteDelayMs 让它晚一拍才把 paste 写进模型 ——
//   「核对没过、字其实晚到了」那一条路。
// - mountDraftEditor：Draft.js 的形状（x.com 发帖框）。模型是一串块
//   `{ key, text }`，每块画成一个带 data-offset-key 的 div。它**不看**原生
//   beforeinput：敲字让浏览器自己插，input 时按选区锚点所在的那个块（closest
//   [data-offset-key]）从 DOM 反推这一块的字，再从模型重画。光标是它自己的模型
//   选区，只从 selectionchange 里学。paste 取消掉，把 text/plain 按 \n 拆块插在
//   模型选区处。撤销一步退一个模型快照。
//   execCommand 插一段带换行的字，Chromium 会把锚点所在的块连同 data-offset-key
//   复制一份，input 时这一块被新块的字覆盖 —— 原文就这么没了。真 Draft 在
//   x.com 上就是这个症状（evidence/r33/b/controller-walk）。
//   输入法组合（compositionstart 起）期间它在组合模式里：不理 input，也不接 paste
//   （真 Draft 的组合处理器没有 onPaste）；compositionend 之后 20ms 才从 DOM 把锚点
//   那一块读回模型（真 Draft 的 RESOLVE_DELAY）。
// - 页面脚本里几种不接管 paste 的 contenteditable（写回会退到 execCommand）：什么
//   都不接的普通框；paste 时把焦点挪去另一个框的（Quill 1.x 的隐藏剪贴板框就这样）；
//   paste 时不取消、却在下一拍自己又把 text/plain 接到末尾的。
//
// 它们只是形状，不是 Draft、Lexical 本身：真编辑器的回归由主控在真站点上复走。

function mountModelEditor(el, { pasteDelayMs = 0 } = {}) {
  const editor = { model: '', history: [], types: [] };
  el.contentEditable = 'true';
  el.setAttribute('role', 'textbox');

  function render() {
    el.replaceChildren(...editor.model.split('\n').map((line) => {
      const row = document.createElement('div');
      if (line) row.textContent = line;
      else row.appendChild(document.createElement('br'));
      return row;
    }));
    const selection = document.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function commit(next) {
    editor.history.push(editor.model);
    editor.model = next;
    queueMicrotask(render);
  }

  el.addEventListener('beforeinput', (e) => {
    e.preventDefault();
    editor.types.push(e.inputType);
    const data = e.data ?? (e.dataTransfer ? e.dataTransfer.getData('text/plain') : '');
    switch (e.inputType) {
      case 'insertText':
      case 'insertReplacementText':
      case 'insertFromPaste':
        if (data) commit(editor.model + data);
        break;
      case 'insertLineBreak':
      case 'insertParagraph':
        commit(editor.model + '\n');
        break;
      case 'deleteContentBackward':
        commit(editor.model.slice(0, -1));
        break;
      default:
        break;
    }
  });
  el.addEventListener('paste', (e) => {
    e.preventDefault();
    editor.types.push('paste');
    const data = e.clipboardData.getData('text/plain');
    if (!data) return;
    if (pasteDelayMs) setTimeout(() => commit(editor.model + data), pasteDelayMs);
    else commit(editor.model + data);
  });
  // 模型之外的改动（有人绕过 beforeinput 直接动了 DOM）在这里被抹掉。
  el.addEventListener('input', () => queueMicrotask(render));
  el.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (editor.history.length) {
        editor.model = editor.history.pop();
        queueMicrotask(render);
      }
    }
  });
  render();
  return editor;
}

function mountDraftEditor(el) {
  let seq = 0;
  const newKey = () => `k${(seq += 1)}-0-0`;
  const editor = { blocks: [{ key: newKey(), text: '' }], caret: null, history: [], pastes: 0, composing: false };
  editor.text = () => editor.blocks.map((block) => block.text).join('\n');
  el.contentEditable = 'true';
  el.setAttribute('role', 'textbox');

  const rowOf = (node) => {
    const element = node && (node.nodeType === 1 ? node : node.parentElement);
    const row = element && element.closest('[data-offset-key]');
    return row && el.contains(row) ? row : null;
  };

  // DOM 上的一个点 → 模型选区 { key, offset }。
  function caretOf(node, offset) {
    if (node === el) {
      const rows = el.children;
      if (offset < rows.length) return { key: rows[offset].dataset.offsetKey, offset: 0 };
      const last = rows[rows.length - 1];
      return { key: last.dataset.offsetKey, offset: last.textContent.length };
    }
    const row = rowOf(node);
    if (!row) return null;
    const range = document.createRange();
    range.setStart(row, 0);
    range.setEnd(node, offset);
    return { key: row.dataset.offsetKey, offset: range.toString().length };
  }

  function placeCaret({ key, offset }) {
    const row = [...el.children].find((child) => child.dataset.offsetKey === key);
    if (!row) return;
    const range = document.createRange();
    if (row.firstChild && row.firstChild.nodeType === 3) range.setStart(row.firstChild, offset);
    else range.setStart(row, 0);
    range.collapse(true);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function render() {
    el.replaceChildren(...editor.blocks.map((block) => {
      const row = document.createElement('div');
      row.dataset.offsetKey = block.key;
      if (block.text) row.textContent = block.text;
      else row.appendChild(document.createElement('br'));
      return row;
    }));
    if (editor.caret && el.contains(document.activeElement)) placeCaret(editor.caret);
  }

  const snapshot = () => editor.blocks.map((block) => ({ ...block }));

  document.addEventListener('selectionchange', () => {
    const selection = document.getSelection();
    if (!selection.rangeCount || !el.contains(selection.anchorNode)) return;
    const caret = caretOf(selection.anchorNode, selection.anchorOffset);
    if (caret) editor.caret = caret;
  });

  // editOnInput：只认锚点所在的那一块，从 DOM 读回它的字。
  function readBack() {
    const selection = document.getSelection();
    const row = rowOf(selection.anchorNode);
    const block = row && editor.blocks.find((b) => b.key === row.dataset.offsetKey);
    if (!block) return;
    editor.history.push(snapshot());
    block.text = row.textContent;
    editor.caret = caretOf(selection.anchorNode, selection.anchorOffset);
    render();
  }
  el.addEventListener('input', () => {
    if (!editor.composing) readBack();
  });
  el.addEventListener('compositionstart', () => { editor.composing = true; });
  el.addEventListener('compositionend', () => {
    setTimeout(() => {
      editor.composing = false;
      readBack();
    }, 20);
  });

  el.addEventListener('paste', (e) => {
    if (editor.composing) return;
    e.preventDefault();
    const data = e.clipboardData.getData('text/plain');
    if (!data || !editor.caret) return;
    editor.pastes += 1;
    editor.history.push(snapshot());
    const at = editor.blocks.findIndex((block) => block.key === editor.caret.key);
    const block = editor.blocks[at];
    const before = block.text.slice(0, editor.caret.offset);
    const after = block.text.slice(editor.caret.offset);
    const made = data.split('\n').map((line, i) => ({ key: i ? newKey() : block.key, text: line }));
    made[0].text = before + made[0].text;
    const last = made[made.length - 1];
    const end = last.text.length;
    last.text += after;
    editor.blocks.splice(at, 1, ...made);
    editor.caret = { key: last.key, offset: end };
    render();
  });

  el.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (!editor.history.length) return;
      editor.blocks = editor.history.pop();
      const last = editor.blocks[editor.blocks.length - 1];
      editor.caret = { key: last.key, offset: last.text.length };
      render();
    }
  });
  render();
  return editor;
}

// 正文要够长、够像英语：页面语言是 chrome.i18n.detectLanguage 从整页正文里读出来
// 的，几十个字符上它很容易判错。
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Harbour forum</title></head>
<body>
  <p>The ferry leaves the northern pier every morning at a quarter past six, and the
     afternoon crossing is posted on the noticeboard by the harbour master every Friday.</p>
  <p>Passengers who miss the early boat can wait for the second sailing or take the
     coastal road around the bay, which adds about forty minutes to the journey.</p>
  <form id="reply-form" action="/posted" method="post">
    <label>Reply <textarea id="reply" rows="4" cols="60"></textarea></label>
    <label>Subject <input id="subject" type="text" size="60"></label>
    <label>Short reply <textarea id="short-reply" rows="2" cols="60" maxlength="50"></textarea></label>
    <label>Short subject <input id="short-subject" type="text" size="60" maxlength="28"></label>
    <button type="submit">Post</button>
  </form>
  <label>Password <input id="secret" type="password"></label>
  <p>Rich editor</p>
  <div id="model-editor" style="min-height:3em;border:1px solid #999"></div>
  <p>Post composer</p>
  <div id="draft-editor" style="min-height:3em;border:1px solid #999"></div>
  <p>Slow editor</p>
  <div id="late-editor" style="min-height:3em;border:1px solid #999"></div>
  <p>Comment box</p>
  <div id="shadow-host"></div>
  <p>Plain editor</p>
  <div id="plain-editor" contenteditable="true" style="min-height:3em;border:1px solid #999"></div>
  <p>Plain editor ending in a line break</p>
  <div id="plain-br-editor" contenteditable="true" style="min-height:3em;border:1px solid #999"></div>
  <p>Editor with a clipboard box</p>
  <div id="thief-editor" contenteditable="true" style="min-height:3em;border:1px solid #999"></div>
  <div id="thief-clipboard" contenteditable="true" style="min-height:1em;border:1px dashed #ccc"></div>
  <p>Editor that pastes on the next tick</p>
  <div id="async-editor" contenteditable="true" style="min-height:3em;border:1px solid #999"></div>
  <script>
    ${mountModelEditor}
    ${mountDraftEditor}
    window.submits = 0;
    window.enters = 0;
    document.getElementById('reply-form').addEventListener('submit', (e) => {
      e.preventDefault();
      window.submits += 1;
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') window.enters += 1;
    }, true);
    window.lightEditor = mountModelEditor(document.getElementById('model-editor'));
    window.draftEditor = mountDraftEditor(document.getElementById('draft-editor'));
    window.lateEditor = mountModelEditor(document.getElementById('late-editor'), { pasteDelayMs: 300 });
    const shadow = document.getElementById('shadow-host').attachShadow({ mode: 'open' });
    const inner = document.createElement('div');
    inner.id = 'shadow-editor';
    inner.style.cssText = 'min-height:3em;border:1px solid #999';
    shadow.appendChild(inner);
    window.shadowEditor = mountModelEditor(inner);
    document.getElementById('thief-editor').addEventListener('paste', () => {
      document.getElementById('thief-clipboard').focus();
    });
    const asyncEditor = document.getElementById('async-editor');
    asyncEditor.addEventListener('paste', (e) => {
      const data = e.clipboardData.getData('text/plain');
      setTimeout(() => asyncEditor.append(data), 0);
    });
  </script>
</body></html>`;

module.exports = { PAGE };
