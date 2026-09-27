// content/content-input-writeback.js 在 Node 里对着一个假 DOM 跑（D-352，写法按 D-357）。
//
// 真浏览器里的那一半 —— 原生撤销栈是不是一步、Draft/Lexical 那类编辑器的模型收没
// 收到 —— 归 test/e2e/input-chip.spec.js。这里钉的是浏览器不好造出来的分支：
// 页面接了 paste 我们就不再插、没接才退到 execCommand、execCommand 答 false 就报错、
// maxlength 装不下就一个字不碰、写完核对要「正好等于」而不是「包含」、核对没过但
// 字晚一拍落进来时 landed() 认得出。
import test from 'node:test';
import assert from 'node:assert/strict';
import { repoSource } from './helpers/sources.mjs';

const SOURCE = repoSource('content/content-input-writeback.js');

class FakeEvent {
  constructor(type, init = {}) {
    Object.assign(this, init);
    this.type = type;
    this.defaultPrevented = false;
  }

  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }
}

class FakeDataTransfer {
  constructor() { this.data = {}; }
  setData(type, value) { this.data[type] = value; }
  getData(type) { return this.data[type] ?? ''; }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.events = [];
    this.listeners = {};
  }

  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }

  dispatchEvent(event) {
    this.events.push(event);
    for (const fn of this.listeners[event.type] || []) fn(event);
    return !event.defaultPrevented;
  }

  contains(node) { return node === this; }
}

// value 访问器数着被直接赋值的次数：写回只许走编辑命令，setter 一次都不该被碰。
class HTMLTextAreaElement extends FakeElement {
  constructor() { super('TEXTAREA'); this.raw = ''; this.setterCalls = 0; this.maxLength = -1; }
  get value() { return this.raw; }
  set value(next) { this.raw = next; this.setterCalls += 1; }
  setSelectionRange(start, end) { this.selection = [start, end]; }
}

class HTMLInputElement extends FakeElement {
  constructor() { super('INPUT'); this.raw = ''; this.setterCalls = 0; this.maxLength = -1; }
  get value() { return this.raw; }
  set value(next) { this.raw = next; this.setterCalls += 1; }
  setSelectionRange(start, end) { this.selection = [start, end]; }
}

class EditableDiv extends FakeElement {
  constructor(text) { super('DIV'); this.innerText = text; this.textContent = text; }
}

// execCommand 的行为由用例决定：answer 是它的返回值，apply 模拟浏览器真的插进去。
// 选区一变，浏览器把 selectionchange 排进任务队列 —— 这里在 addRange 时排一个
// setTimeout 去点亮 target.caretSeen，模拟编辑器「从 selectionchange 学到光标」。
function load({ answer = true, apply = true } = {}) {
  const calls = [];
  const ranges = [];
  const document = {
    activeElement: null,
    execCommand(command, ui, data) {
      calls.push({ command, ui, data });
      if (answer && apply && document.target) {
        const field = document.target;
        if (field.tagName === 'DIV') {
          field.innerText += data;
        } else {
          const [start, end] = field.selection;
          field.raw = field.raw.slice(0, start) + data + field.raw.slice(end);
        }
      }
      return answer;
    },
    getSelection() {
      return {
        rangeCount: ranges.length,
        getRangeAt: (i) => ranges[i],
        removeAllRanges: () => { ranges.length = 0; },
        addRange: (range) => {
          ranges.push(range);
          const field = document.target;
          if (field) setTimeout(() => { field.caretSeen = true; }, 0);
        },
      };
    },
    createRange() {
      return {
        selectNodeContents(node) { this.startContainer = node; this.endContainer = node; this.startOffset = 0; this.endOffset = 1; },
        collapse(toStart) { if (!toStart) this.startOffset = this.endOffset; },
      };
    },
  };
  const ctx = {};
  const window = { AI_TRANSLATOR_CONTENT: ctx, HTMLTextAreaElement, HTMLInputElement };
  new Function('window', 'document', 'ClipboardEvent', 'DataTransfer', SOURCE)(
    window, document, FakeEvent, FakeDataTransfer);
  return { writeback: ctx.inputWriteback, document, calls };
}

function textarea(value) {
  const field = new HTMLTextAreaElement();
  field.raw = value;
  return field;
}

function input(value) {
  const field = new HTMLInputElement();
  field.raw = value;
  return field;
}

// 一个接 paste 的编辑器（Draft、Lexical 的形状）：取消事件，按 text/plain 改自己的
// 模型再画回 DOM。write 决定它到底写什么、什么时候写。
function takesPaste(field, write = (data) => { field.innerText += data; }) {
  const pastes = [];
  field.addEventListener('paste', (e) => {
    e.preventDefault();
    const data = e.clipboardData.getData('text/plain');
    pastes.push({ data, caretSeen: !!field.caretSeen });
    write(data);
  });
  return pastes;
}

test('多行框：光标放到末尾，换一行接上译文，只走 insertText', async () => {
  const { writeback, document, calls } = load();
  const field = textarea('你好世界');
  document.target = field;
  await writeback.write(field, '  Hello world  ');
  assert.deepEqual(field.selection, [4, 4]);
  assert.equal(field.value, '你好世界\nHello world');
  assert.deepEqual(calls, [{ command: 'insertText', ui: false, data: '\nHello world' }]);
  assert.deepEqual(field.events, [], '原生框上不该派发任何合成事件（beforeinput、paste、input）');
  assert.equal(field.setterCalls, 0);
});

test('多行框已经以换行结尾：不再多补一个换行', async () => {
  const { writeback, document, calls } = load();
  const field = textarea('你好\n');
  document.target = field;
  await writeback.write(field, 'Hello');
  assert.equal(calls[0].data, 'Hello');
  assert.equal(field.value, '你好\nHello');
});

test('单行框：整段选中，用译文替换原文', async () => {
  const { writeback, document, calls } = load();
  const field = input('你好世界');
  document.target = field;
  await writeback.write(field, 'Hello world');
  assert.deepEqual(field.selection, [0, 4]);
  assert.equal(calls[0].data, 'Hello world');
  assert.equal(field.value, 'Hello world');
});

test('原生框 execCommand 答 false：报错，不另找一条 setter 的路', async () => {
  const { writeback, document } = load({ answer: false });
  const field = textarea('你好世界');
  document.target = field;
  await assert.rejects(writeback.write(field, 'Hello'), /insertText refused/);
  assert.equal(field.value, '你好世界');
  assert.equal(field.setterCalls, 0);
  assert.deepEqual(field.events, []);
  assert.equal(writeback.landed(field), false, '框没动过，不该记成「晚到」');
});

// 浏览器会把超出 maxlength 的那一截悄悄截掉：用户得到半截译文。预检不过就一个字
// 都不碰 —— 连选区都不动。
test('单行框装不下译文（maxlength）：报错，框里的字、选区一样都不动', async () => {
  const { writeback, document, calls } = load();
  const field = input('你好');
  field.maxLength = 10;
  document.target = field;
  await assert.rejects(writeback.write(field, 'Hello world'), /exceeds maxlength/);
  assert.equal(field.value, '你好');
  assert.equal(field.selection, undefined);
  assert.deepEqual(calls, []);
  assert.equal(field.setterCalls, 0);
});

test('多行框装不下「原文 + 换行 + 译文」（maxlength）：报错不动；正好装得下就写', async () => {
  const { writeback, document, calls } = load();
  const field = textarea('你好世界');
  // 你好世界 + \n + Hello = 10 个 UTF-16 单元。
  field.maxLength = 9;
  document.target = field;
  await assert.rejects(writeback.write(field, 'Hello'), /exceeds maxlength/);
  assert.equal(field.value, '你好世界');
  assert.deepEqual(calls, []);

  field.maxLength = 10;
  await writeback.write(field, 'Hello');
  assert.equal(field.value, '你好世界\nHello');
});

test('contenteditable：光标到末尾、等 selectionchange 过去，再递一次 paste；页面接了就不再插', async () => {
  const { writeback, document, calls } = load();
  const field = new EditableDiv('你好世界');
  document.target = field;
  const pastes = takesPaste(field);
  await writeback.write(field, 'Hello');
  assert.deepEqual(pastes, [{ data: '\nHello', caretSeen: true }],
    'paste 在编辑器学到新光标之前就发了，字会插在用户原来的光标处');
  assert.deepEqual(calls, [], '编辑器接了 paste 之后又走了一次 execCommand，译文会出现两遍');
  assert.equal(field.innerText, '你好世界\nHello');
  const paste = field.events.find((e) => e.type === 'paste');
  assert.equal(paste.bubbles, true);
  assert.equal(paste.cancelable, true);
  assert.equal(paste.composed, true, 'shadow root 里的编辑器收不到不 composed 的事件');
  assert.ok(!field.events.some((e) => e.type === 'beforeinput'), '合成 beforeinput 的旧路又回来了');
});

test('contenteditable 没人接 paste：退到 execCommand insertText', async () => {
  const { writeback, document, calls } = load();
  const field = new EditableDiv('你好世界');
  document.target = field;
  await writeback.write(field, 'Hello');
  assert.deepEqual(calls, [{ command: 'insertText', ui: false, data: '\nHello' }]);
  assert.equal(field.innerText, '你好世界\nHello');
});

test('contenteditable 没人接 paste、execCommand 也答 false：报错', async () => {
  const { writeback, document } = load({ answer: false });
  const field = new EditableDiv('你好世界');
  document.target = field;
  await assert.rejects(writeback.write(field, 'Hello'), /insertText refused/);
  assert.equal(field.innerText, '你好世界');
});

// 译文恰好是原文的一段：页面取消了 paste 却什么都没写，「包含译文」这把尺子量
// 出来是成功。要比的是整段。
test('写完核对是「正好等于」：译文是原文的一段、编辑器吞了 paste 没写，照样报错', async () => {
  const { writeback, document, calls } = load();
  const field = new EditableDiv('Hello 你好');
  document.target = field;
  takesPaste(field, () => {});
  await assert.rejects(writeback.write(field, 'Hello'), /does not read as expected/);
  assert.deepEqual(calls, []);
  assert.equal(field.innerText, 'Hello 你好');
});

test('编辑器多画了一份（译文两遍）：核对不过', async () => {
  const { writeback, document } = load();
  const field = new EditableDiv('你好');
  document.target = field;
  takesPaste(field, (data) => { field.innerText += data + data; });
  await assert.rejects(writeback.write(field, 'Hello'), /does not read as expected/);
});

// 编辑器晚一拍才把字画进来：这一次报错了，但框里其实已经是「原文 + 译文」。重试
// 之前先问 landed() —— 认得出来，就不会再追加一份。
test('核对没过、字晚一拍落进来：landed() 认得出，只认一次；框里是别的样子就不认', async () => {
  const { writeback, document } = load();
  const field = new EditableDiv('你好');
  document.target = field;
  let late = null;
  takesPaste(field, (data) => { late = () => { field.innerText += data; }; });
  await assert.rejects(writeback.write(field, 'Hello'), /does not read as expected/);
  assert.equal(writeback.landed(field), false, '字还没落进来就说落进来了');

  late();
  field.innerText += '!';
  assert.equal(writeback.landed(field), false, '框里的字已经不是预期的样子，也认成了写成');
  field.innerText = '你好\n\nHello';
  assert.equal(writeback.landed(field), true, 'Lexical 那样多一个空段落也是写成了');
  assert.equal(writeback.landed(field), false, '同一次写入被认了两次');
});

test('新的一次写入把上一次「晚到」的记录清掉', async () => {
  // execCommand 答 true 却没插：核对不过，记下「晚到」。
  const { writeback, document } = load({ apply: false });
  const field = textarea('你好');
  document.target = field;
  await assert.rejects(writeback.write(field, 'Hello'), /does not read as expected/);
  // 下一次写在预检就停了：框没动，但上一次的预期已经作废。
  field.maxLength = 3;
  await assert.rejects(writeback.write(field, 'Bye'), /exceeds maxlength/);
  field.raw = '你好\nHello';
  assert.equal(writeback.landed(field), false, '上一次的预期还留着，会把旧译文认成这一次写成');
});

test('空译文：报错，框不动', async () => {
  const { writeback, document, calls } = load();
  const field = textarea('你好');
  document.target = field;
  await assert.rejects(writeback.write(field, '   '), /empty translation/);
  assert.equal(calls.length, 0);
  assert.equal(field.events.length, 0);
});

test('焦点往 shadow root 里追', () => {
  const { writeback, document } = load();
  const inner = new EditableDiv('');
  const host = { shadowRoot: { activeElement: inner } };
  document.activeElement = host;
  assert.equal(writeback.hasFocus(inner), true);
  document.activeElement = new EditableDiv('');
  assert.equal(writeback.hasFocus(inner), false);
});
