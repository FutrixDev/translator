// 页内拾取器给点中的元素生成的选择器（content/picker/selector.js）。
//
// 规则存下来长期复用，所以优先级是「最不容易随站点构建变化」的那一条：
//   稳定 id > 稳定 data-* > 标签 + 非哈希类名 > nth-of-type 链（至多 5 层）
// 唯一性只在元素自己的 root 里判。
//
// 没有 DOM 库可用，这里拿一小撮假节点在 vm 里跑：selector.js 只用 tagName、id、
// classList、attributes、parentElement、children、getRootNode、querySelectorAll、
// closest。
// 假 querySelectorAll 只认 selector.js 会写出来的那几种形状（复合选择器 + `>`），
// 认不出的形状抛错 —— 和浏览器对无效选择器的反应一样。
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { pickerSource } from './helpers/sources.mjs';

function parseCompound(text) {
  const re = /^([a-z][a-z0-9]*)?((?:#[A-Za-z_][\w-]*|\.[A-Za-z_][\w-]*|\[[\w-]+="[^"]*"\]|:nth-of-type\(\d+\))*)$/;
  const m = re.exec(text);
  if (!m) throw new SyntaxError(`fake DOM cannot parse ${text}`);
  const parts = { tag: m[1] || null, ids: [], classes: [], attrs: [], nth: null };
  for (const [piece] of m[2].matchAll(/#[\w-]+|\.[\w-]+|\[[\w-]+="[^"]*"\]|:nth-of-type\(\d+\)/g)) {
    if (piece[0] === '#') parts.ids.push(piece.slice(1));
    else if (piece[0] === '.') parts.classes.push(piece.slice(1));
    else if (piece[0] === '[') {
      const [, name, value] = /^\[([\w-]+)="([^"]*)"\]$/.exec(piece);
      parts.attrs.push([name, value]);
    } else parts.nth = Number(/\d+/.exec(piece)[0]);
  }
  return parts;
}

function matchesCompound(el, c) {
  if (c.tag && el.tagName.toLowerCase() !== c.tag) return false;
  if (c.ids.some((id) => el.id !== id)) return false;
  if (c.classes.some((name) => !el.classList.includes(name))) return false;
  if (c.attrs.some(([name, value]) => el.getAttribute(name) !== value)) return false;
  if (c.nth !== null) {
    const parent = el.parentElement;
    const same = parent ? parent.children.filter((x) => x.tagName === el.tagName) : [el];
    if (same.indexOf(el) + 1 !== c.nth) return false;
  }
  return true;
}

function matches(el, selector) {
  const chain = selector.split(/\s*>\s*/).map(parseCompound);
  let cur = el;
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    if (!cur || !matchesCompound(cur, chain[i])) return false;
    cur = cur.parentElement;
  }
  return true;
}

class FakeRoot {
  constructor() { this.children = []; }
  all() {
    const out = [];
    const walk = (el) => { out.push(el); el.children.forEach(walk); };
    this.children.forEach(walk);
    return out;
  }
  querySelectorAll(selector) {
    const chain = selector.split(/\s*>\s*/);
    chain.forEach(parseCompound); // 抛 SyntaxError，和浏览器一样
    return this.all().filter((el) => matches(el, selector));
  }
}

class FakeElement {
  constructor(tag, { id = '', classes = [], attrs = {} } = {}) {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.classList = classes;
    this.attrMap = { ...attrs };
    if (id) this.attrMap.id = id;
    if (classes.length) this.attrMap.class = classes.join(' ');
    this.children = [];
    this.parentElement = null;
    this.root = null;
  }
  get attributes() {
    return Object.entries(this.attrMap).map(([name, value]) => ({ name, value }));
  }
  getAttribute(name) {
    return name in this.attrMap ? this.attrMap[name] : null;
  }
  getRootNode() { return this.root; }
  closest(selector) {
    const list = selector.split(/\s*,\s*/);
    for (let cur = this; cur; cur = cur.parentElement) {
      if (list.some((one) => matches(cur, one))) return cur;
    }
    return null;
  }
  append(...kids) {
    for (const kid of kids) {
      kid.parentElement = this;
      this.children.push(kid);
      const setRoot = (el) => { el.root = this.root; el.children.forEach(setRoot); };
      setRoot(kid);
    }
    return this;
  }
}

function tree(build) {
  const root = new FakeRoot();
  const html = new FakeElement('html');
  html.root = root;
  root.children.push(html);
  const body = new FakeElement('body');
  html.append(body);
  build(body);
  return root;
}

const el = (tag, opts) => new FakeElement(tag, opts);

function loadPicker() {
  // 界面根清单取一小段就够：假 closest 按逗号拆开逐条比。
  const ctx = { constants: { OWN_UI_SELECTOR: '.ai-translator-popup, #ai-translator-rule-picker' } };
  const sandbox = { window: { AI_TRANSLATOR_CONTENT: ctx } };
  vm.runInNewContext(pickerSource('selector.js'), sandbox);
  return ctx.picker;
}

const picker = loadPicker();

test('a stable unique id wins over everything else', () => {
  let target;
  tree((body) => body.append(
    target = el('div', { id: 'comments', classes: ['thread'], attrs: { 'data-testid': 'c' } }),
  ));
  assert.equal(picker.selectorFor(target), '#comments');
});

test('a generated id is skipped and a test attribute is taken instead', () => {
  let target;
  tree((body) => body.append(
    target = el('div', { id: 'ember1234', attrs: { 'data-role': 'box', 'data-testid': 'sidebar' } }),
  ));
  // data-testid 排在别的 data-* 前面，不按字母序。
  assert.equal(picker.selectorFor(target), 'div[data-testid="sidebar"]');
});

test('our own data attributes are never written into a rule', () => {
  let target;
  tree((body) => body.append(
    target = el('p', { classes: ['lede'], attrs: { 'data-ai-translator-state': 'done' } }),
  ));
  assert.equal(picker.selectorFor(target), 'p.lede');
});

test('tag plus stable classes, hashed classes dropped, at most three', () => {
  let target;
  tree((body) => body.append(
    target = el('aside', { classes: ['css-1x2y3z', 'promo', 'sc-AbCdE', 'wide', 'dark', 'boxed'] }),
    el('aside', { classes: ['promo'] }),
  ));
  assert.equal(picker.selectorFor(target), 'aside.promo.wide.dark');
});

test('the volatile-class table', () => {
  // _1abc 只有「下划线打头接数字」一条规则认得（_3fX9a 同时是大小写混排带数字），
  // 少了它那条规则，这张表就守不住。
  const volatile = ['ember123', 'jss1234', 'css-1x2y3z', 'sc-AbCdE', '_3fX9a', '_1abc', 'Button__root__1a2b3',
    'kLmN3p', 'md:flex', ':r1:', ''];
  const stable = ['promo', 'nav-bar', 'comment_body', 'h2', 'col-12', 'Header', 'isActive'];
  for (const name of volatile) assert.equal(picker.isVolatileClass(name), true, `${name} should be volatile`);
  for (const name of stable) assert.equal(picker.isVolatileClass(name), false, `${name} should be stable`);
});

test('a class that is not unique falls through to an nth-of-type chain', () => {
  let target;
  tree((body) => body.append(
    el('section').append(
      el('p', { classes: ['note'] }),
      target = el('p', { classes: ['note'] }),
    ),
  ));
  // 链一唯一就停：一层就够时不往上写。
  assert.equal(picker.selectorFor(target), 'p:nth-of-type(2)');
});

test('the chain stops at an ancestor with a stable id', () => {
  let target;
  tree((body) => body.append(
    el('nav').append(el('ul').append(el('li'), el('li'))),
    el('main', { id: 'content' }).append(
      el('ul').append(el('li'), target = el('li')),
      el('ul').append(el('li'), el('li')),
    ),
  ));
  // 两层在 nav 里也中一处，第三层碰到 #content 就以它作锚。
  assert.equal(picker.selectorFor(target), '#content > ul:nth-of-type(1) > li:nth-of-type(2)');
});

test('the chain is capped at five parts, even when five are not unique', () => {
  // 两棵一样深的树：六层才分得开，五层就交差。
  const deep = () => el('div').append(el('div').append(el('div').append(el('div').append(
    el('div').append(el('span'))))));
  let root;
  tree((body) => {
    root = body;
    body.append(deep(), deep());
  });
  const first = root.children[0];
  let target = first;
  while (target.children.length) target = target.children[0];
  const selector = picker.selectorFor(target);
  assert.equal(selector.split(' > ').length, picker.MAX_CHAIN);
  assert.equal(picker.MAX_CHAIN, 5);
});

test('uniqueness is judged inside the element\'s own root', () => {
  // 两个 root 各有一个 #comments：各自唯一，各自拿到 #comments。
  let a;
  let b;
  tree((body) => body.append(a = el('div', { id: 'comments' })));
  tree((body) => body.append(b = el('div', { id: 'comments' })));
  assert.equal(picker.selectorFor(a), '#comments');
  assert.equal(picker.selectorFor(b), '#comments');
  // 同一个 root 里两个同 id：不唯一，退到链。
  let dup;
  tree((body) => body.append(el('div', { id: 'x' }), dup = el('div', { id: 'x' })));
  assert.equal(picker.selectorFor(dup), 'div:nth-of-type(2)');
});

test('a clone inside our translation does not make a page element ambiguous', () => {
  // 整页翻译把段落里的行内元素克隆进译文节点：span.promo-tag 在页面上有两份，
  // 一份是我们的。它不算，选择器照样是 span.promo-tag，不退到位置链。
  let target;
  let clone;
  tree((body) => body.append(
    el('p', { id: 'inline', classes: ['ai-translator-translated'] }).append(
      target = el('span', { classes: ['promo-tag'] }),
      el('font', { classes: ['ai-translator-inline-block'] }).append(
        clone = el('span', { classes: ['promo-tag'] }),
      ),
    ),
    el('div', { id: 'ai-translator-rule-picker' }).append(el('span', { classes: ['promo-tag'] })),
  ));
  assert.equal(picker.selectorFor(target), 'span.promo-tag');
  assert.equal(picker.isPageNode(target), true);
  assert.equal(picker.isPageNode(clone), false);
});
