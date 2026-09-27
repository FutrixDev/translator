// content/content-input-writeback.js 在 Node 里对着一个假 DOM 跑（D-352）。
//
// 真浏览器里的那一半 —— 原生撤销栈是不是一步、Draft/Lexical 那类编辑器的模型收没
// 收到 —— 归 test/e2e/input-chip.spec.js。这里钉的是浏览器不好造出来的分支：
// execCommand 答 false 时的 setter 退路、编辑器接手 beforeinput 之后我们就不再插、
// 写完一核对发现字不在框里就报错。
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

class FakeStaticRange {
  constructor(init) { Object.assign(this, init); }
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

// 原型上的 value 访问器 —— 写回模块的退路就是绕过实例、直接调它。
class HTMLTextAreaElement extends FakeElement {
  constructor() { super('TEXTAREA'); this.raw = ''; this.setterCalls = 0; }
  get value() { return this.raw; }
  set value(next) { this.raw = next; this.setterCalls += 1; }
  setSelectionRange(start, end) { this.selection = [start, end]; }
}

class HTMLInputElement extends FakeElement {
  constructor() { super('INPUT'); this.raw = ''; this.setterCalls = 0; }
  get value() { return this.raw; }
  set value(next) { this.raw = next; this.setterCalls += 1; }
  setSelectionRange(start, end) { this.selection = [start, end]; }
}

class EditableDiv extends FakeElement {
  constructor(text) { super('DIV'); this.innerText = text; this.textContent = text; }
}

// execCommand 的行为由用例决定：answer 是它的返回值，apply 模拟浏览器真的插进去。
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
        addRange: (range) => { ranges.push(range); },
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
  new Function('window', 'document', 'InputEvent', 'StaticRange', SOURCE)(
    window, document, FakeEvent, FakeStaticRange);
  return { writeback: ctx.inputWriteback, document, calls };
}

function textarea(value) {
  const field = new HTMLTextAreaElement();
  field.raw = value;
  return field;
}

test('多行框：光标放到末尾，换一行接上译文；先发 beforeinput 再走 insertText', async () => {
  const { writeback, document, calls } = load();
  const field = textarea('你好世界');
  document.target = field;
  await writeback.write(field, '  Hello world  ');
  assert.deepEqual(field.selection, [4, 4]);
  assert.equal(field.value, '你好世界\nHello world');
  assert.deepEqual(calls, [{ command: 'insertText', ui: false, data: '\nHello world' }]);
  const before = field.events.filter((e) => e.type === 'beforeinput');
  assert.equal(before.length, 1);
  assert.equal(before[0].inputType, 'insertText');
  assert.equal(before[0].data, '\nHello world');
  assert.equal(before[0].cancelable, true);
  assert.equal(before[0].composed, true);
  assert.equal(field.setterCalls, 0, 'execCommand 能用时不该再走 setter');
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
  const field = new HTMLInputElement();
  field.raw = '你好世界';
  document.target = field;
  await writeback.write(field, 'Hello world');
  assert.deepEqual(field.selection, [0, 4]);
  assert.equal(calls[0].data, 'Hello world');
  assert.equal(field.value, 'Hello world');
});

test('execCommand 答 false：原生框走原型上的 setter，再发一个 input', async () => {
  const { writeback, document } = load({ answer: false });
  const field = textarea('你好世界');
  document.target = field;
  await writeback.write(field, 'Hello');
  assert.equal(field.value, '你好世界\nHello');
  assert.equal(field.setterCalls, 1);
  const inputs = field.events.filter((e) => e.type === 'input');
  assert.equal(inputs.length, 1, 'setter 之后没有 input 事件，受控组件收不到新值');
  assert.equal(inputs[0].inputType, 'insertText');
  assert.equal(inputs[0].bubbles, true);
});

test('单行框 execCommand 答 false：setter 写的是译文本身', async () => {
  const { writeback, document } = load({ answer: false });
  const field = new HTMLInputElement();
  field.raw = '你好';
  document.target = field;
  await writeback.write(field, 'Hello');
  assert.equal(field.value, 'Hello');
});

test('编辑器接手了 beforeinput：我们不再插第二遍', async () => {
  const { writeback, document, calls } = load();
  const field = new EditableDiv('你好世界');
  document.target = field;
  // 自己维护模型的编辑器：取消事件，按 data 改模型，再画回 DOM。
  field.addEventListener('beforeinput', (e) => {
    e.preventDefault();
    field.innerText += e.data;
  });
  await writeback.write(field, 'Hello');
  assert.equal(calls.length, 0, '编辑器接手之后又走了一次 execCommand，译文会出现两遍');
  assert.equal(field.innerText, '你好世界\nHello');
  const before = field.events.find((e) => e.type === 'beforeinput');
  assert.equal(before.targetRanges.length, 1, 'contenteditable 的 beforeinput 没带 targetRanges');
});

test('contenteditable 上 execCommand 答 false：报错，不另找一条直接改 DOM 的路', async () => {
  const { writeback, document } = load({ answer: false });
  const field = new EditableDiv('你好世界');
  document.target = field;
  await assert.rejects(writeback.write(field, 'Hello'), /insertText refused/);
  assert.equal(field.innerText, '你好世界');
});

test('写完核对：字不在框里就报错，不当成功', async () => {
  // 页面取消了 beforeinput 却什么都没做。
  const { writeback, document, calls } = load();
  const field = new EditableDiv('你好世界');
  document.target = field;
  field.addEventListener('beforeinput', (e) => e.preventDefault());
  await assert.rejects(writeback.write(field, 'Hello'), /did not take the translation/);
  assert.equal(calls.length, 0);
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
